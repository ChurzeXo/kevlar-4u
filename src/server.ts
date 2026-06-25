import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

import { createToolRegistry } from "./tools/index.js";
import type { ToolDependencies } from "./tools/types.js";
import { logger } from "./utils/logger.js";
import { formatErrorResponse } from "./utils/errors.js";
import { getErrorInfo } from "./utils/observability.js";
import { resolveSamplingFn } from "./execution/sampling.js";
import { setClientInfo, setClientCapabilities } from "./execution/client.js";
import { setConfigPath } from "./execution/config.js";
import { setObservationCacheDir } from "./execution/observations.js";
import type { MultiTurnSamplingFunction } from "./execution/base.js";
import { SERVER_INSTRUCTIONS } from "./prompts/instructions.js";
import { DynamicImportProRuntimeLoader, resolveStrategyProvider } from "./execution/proRuntime.js";

// Priority:
//   1. KEVLAR_SKILLS_DIR environment variable (absolute path)
//   2. <repo-root>/skills/  (relative to this file's compiled location)
function resolveSkillsDir(): string {
  if (process.env.KEVLAR_SKILLS_DIR) {
    return path.resolve(process.env.KEVLAR_SKILLS_DIR);
  }
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // dist/*.js after compilation (rootDir: "./src"); go up one level to repo root
  const repoRoot = path.resolve(__dirname, "..");
  return path.join(repoRoot, "skills");
}

const STALE_WIZARD_SUFFIXES = new Set([
  '_draft.json',
  '_wizard.json',
  '_review_wizard.json',
  '_configure_wizard.json',
  '_delete_wizard.json',
]);

function isWizardFile(file: string): boolean {
  for (const suffix of STALE_WIZARD_SUFFIXES) {
    if (file.endsWith(suffix)) return true;
  }
  return false;
}

async function cleanStaleDrafts(tmpDir: string) {
  try {
    if (!fs.existsSync(tmpDir)) return;
    const files = await fs.promises.readdir(tmpDir);
    const now = Date.now();
    const deletePromises: Promise<void>[] = [];
    for (const file of files) {
      if (!isWizardFile(file)) continue;
      const filePath = path.join(tmpDir, file);
      deletePromises.push((async () => {
        try {
          const data = await fs.promises.readFile(filePath, 'utf-8');
          const state = JSON.parse(data);
          if (state.createdAt && now - state.createdAt > 86400000) {
            await fs.promises.unlink(filePath);
            logger.info("Cleaned stale wizard state", { event: "clean_stale_wizard", file });
          }
        } catch (err) {
          // JSON parse error or missing createdAt - clean up corrupted file
          try {
            await fs.promises.unlink(filePath);
            logger.info("Cleaned corrupted wizard state", { event: "clean_corrupted_wizard", file });
          } catch {
            // Ignore cleanup errors
          }
        }
      })());
    }
    await Promise.all(deletePromises);
  } catch (err) {
    const info = getErrorInfo(err);
    logger.warn("Failed to clean stale wizard states", { event: "clean_stale_wizards_error", error: info.code, message: info.message });
  }
}

function ensureSkillsDirectory(skillsDir: string) {
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
    logger.info("Created skills directory", { event: "dir_created", path: skillsDir });
  } else {
    logger.info("Using skills directory", { event: "dir_using", path: skillsDir });
  }
}

function createMultiTurnSamplingFn(serverInstance: any): MultiTurnSamplingFunction {
  return async (params) => {
    try {
      const result = await serverInstance.createMessage({
        systemPrompt: params.systemPrompt,
        messages: params.messages.map(m => ({
          role: m.role,
          content: { type: "text", text: m.content },
        })),
        maxTokens: params.maxTokens || 4096,
      });

      const textContent = result.content.type === "text" ? result.content.text : "";
      return {
        content: textContent,
        stopReason: result.stopReason,
      };
    } catch (err) {
      const info = getErrorInfo(err);
      logger.error("Multi-turn Sampling request failed", {
        event: "multi_sampling_request_error",
        error: info.code,
        message: info.message,
        recoverable: info.recoverable,
      });
      throw new Error(`多轮 Sampling 调用失败: ${info.message}`);
    }
  };
}

async function buildToolDependencies(
  skillsDir: string,
  tmpDir: string,
  underlyingServer: any,
): Promise<ToolDependencies> {
  const proLoader = new DynamicImportProRuntimeLoader();
  const strategyProvider = await resolveStrategyProvider(proLoader, skillsDir);

  // Eagerly capture client capabilities for isSamplingSupported() checks
  const clientVersion = underlyingServer.getClientVersion();
  if (clientVersion) {
    setClientInfo(clientVersion.name, clientVersion.version);
  }
  const clientCaps = underlyingServer.getClientCapabilities();
  if (clientCaps) {
    setClientCapabilities(clientCaps);
  }

  return {
    skillsDir,
    tmpDir,
    resolveSamplingFn: () => resolveSamplingFn({
      getClientVersion: () => underlyingServer.getClientVersion(),
      getClientCapabilities: () => underlyingServer.getClientCapabilities(),
      createFn: () => createMultiTurnSamplingFn(underlyingServer),
    }),
    sendProgress: (message: string) => {
      try {
        const result = underlyingServer.sendLoggingMessage({
          level: "info",
          logger: "kevlar-audit",
          data: message,
        });
        if (result && typeof result.catch === 'function') {
          result.catch(() => {/* fire-and-forget */});
        }
      } catch (err) {
        // Ignore synchronous throws from MCP SDK if logging is not enabled
      }
    },
    strategyProvider,
  };
}

function setupListToolsHandler(
  underlyingServer: any,
  toolDefinitions: any[],
) {
  underlyingServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: toolDefinitions };
  });
}

function setupCallToolHandler(
  underlyingServer: any,
  registry: Map<string, any>,
) {
  underlyingServer.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const { name, arguments: args } = request.params;
    const startTime = Date.now();

    logger.debug("Tool call received", { event: "tool_called", tool: name });

    try {
      const sanitizedArgs = args && typeof args === "object"
        ? (args as Record<string, unknown>)
        : undefined;
      const handler = registry.get(name);
      if (!handler) {
        logger.warn("Unknown tool requested", { event: "unknown_tool", tool: name });
        throw new Error(`Unknown tool: ${name}`);
      }
      const result = await handler(sanitizedArgs);
      logger.info("Tool completed", {
        event: "tool_completed",
        tool: name,
        durationMs: Date.now() - startTime,
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const info = getErrorInfo(err);
      logger.error("Tool execution failed", {
        event: "tool_error",
        tool: name,
        error: info.code,
        message: info.message,
        recoverable: info.recoverable,
        durationMs,
      });
      return formatErrorResponse(err);
    }
  });
}

export async function createKevlarServer(): Promise<McpServer> {
  const skillsDir = resolveSkillsDir();
  const tmpDir = path.join(skillsDir, "tmp");

  setConfigPath(skillsDir);
  setObservationCacheDir(tmpDir);
  ensureSkillsDirectory(skillsDir);
  cleanStaleDrafts(tmpDir).catch(() => {});

  const mcpServer = new McpServer(
    {
      name: "kevlar-4u",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  const underlyingServer = mcpServer.server;
  const deps = await buildToolDependencies(skillsDir, tmpDir, underlyingServer);
  const { registry, toolDefinitions } = createToolRegistry(deps);

  setupListToolsHandler(underlyingServer, toolDefinitions);
  setupCallToolHandler(underlyingServer, registry);

  return mcpServer;
}
