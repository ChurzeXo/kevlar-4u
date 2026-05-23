import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

import { createToolRegistry } from "./tools/index.js";
import type { ToolDependencies } from "./tools/types.js";
import { logger } from "./utils/logger.js";
import { formatErrorResponse, getErrorInfo } from "./utils/errors.js";
import { isSamplingSupported, setClientInfo } from "./execution/client.js";
import { setConfigPath } from "./execution/config.js";
import type { SamplingFunction, MultiTurnSamplingFunction } from "./execution/base.js";

// Priority:
//   1. KEVLAR_SKILLS_DIR environment variable (absolute path)
//   2. <repo-root>/skills/  (relative to this file's compiled location)
function resolveSkillsDir(): string {
  if (process.env.KEVLAR_SKILLS_DIR) {
    return path.resolve(process.env.KEVLAR_SKILLS_DIR);
  }
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // dist/ after compilation; go up one level to repo root
  const repoRoot = path.resolve(__dirname, "..");
  return path.join(repoRoot, "skills");
}

async function cleanStaleDrafts(tmpDir: string) {
  try {
    if (!fs.existsSync(tmpDir)) return;
    const files = await fs.promises.readdir(tmpDir);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith('_draft.json') && !file.endsWith('_wizard.json') && !file.endsWith('_review_wizard.json') && !file.endsWith('_configure_wizard.json') && !file.endsWith('_delete_wizard.json')) continue;
      const filePath = path.join(tmpDir, file);
      try {
        const data = await fs.promises.readFile(filePath, 'utf-8');
        const state = JSON.parse(data);
        if (state.createdAt && now - state.createdAt > 86400000) {
          await fs.promises.unlink(filePath);
          logger.info("Cleaned stale wizard state", { event: "clean_stale_wizard", file });
        }
      } catch (err) {
      }
    }
  } catch (err) {
    logger.warn("Failed to clean stale wizard states", { event: "clean_stale_wizards_error", error: String(err) });
  }
}

export function createKevlarServer(): McpServer {
  const skillsDir = resolveSkillsDir();
  const tmpDir = path.join(skillsDir, "tmp");

  setConfigPath(skillsDir);

  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
    logger.info("Created skills directory", { event: "dir_created", path: skillsDir });
  } else {
    logger.info("Using skills directory", { event: "dir_using", path: skillsDir });
  }

  cleanStaleDrafts(tmpDir).catch(() => {});

  const mcpServer = new McpServer(
    {
      name: "kevlar",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    }
  );

  const underlyingServer = mcpServer.server;

  const updateClientSamplingSupport = (): boolean => {
    const clientVersion = underlyingServer.getClientVersion();
    if (clientVersion) {
      setClientInfo(clientVersion.name, clientVersion.version);
      return isSamplingSupported(clientVersion.name);
    }
    return false;
  };

  const createSamplingFn = (serverInstance: any): SamplingFunction => {
    return async (params: {
      systemPrompt: string;
      message: string;
      maxTokens?: number
    }) => {
      try {
        const result = await serverInstance.createMessage({
          systemPrompt: params.systemPrompt,
          messages: [{ role: "user", content: { type: "text", text: params.message } }],
          maxTokens: params.maxTokens || 4096,
        });

        const textContent = result.content.type === "text" ? result.content.text : "";
        return {
          content: textContent,
          stopReason: result.stopReason,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error("Sampling request failed", {
          event: "sampling_request_error",
          error: errorMsg
        });
        throw new Error(`Sampling 调用失败: ${errorMsg}`);
      }
    };
  };

  const createMultiTurnSamplingFn = (serverInstance: any): MultiTurnSamplingFunction => {
    return async (params) => {
      try {
        const result = await serverInstance.createMessage({
          systemPrompt: params.systemPrompt,
          messages: params.messages.map(m => ({
            role: m.role,
            content: { type: "text", text: m.content }
          })),
          maxTokens: params.maxTokens || 4096,
        });

        const textContent = result.content.type === "text" ? result.content.text : "";
        return {
          content: textContent,
          stopReason: result.stopReason,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error("Multi-turn Sampling request failed", {
          event: "multi_sampling_request_error",
          error: errorMsg
        });
        throw new Error(`多轮 Sampling 调用失败: ${errorMsg}`);
      }
    };
  };

  const deps: ToolDependencies = {
    skillsDir,
    tmpDir,
    createSamplingFn: () => createSamplingFn(underlyingServer),
    createMultiTurnSamplingFn: () => createMultiTurnSamplingFn(underlyingServer),
    updateClientSamplingSupport,
  };

  const { registry, toolDefinitions } = createToolRegistry(deps);

  underlyingServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: toolDefinitions };
  });

  underlyingServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startTime = Date.now();

    logger.debug("Tool call received", { event: "tool_called", tool: name });

    try {
      const sanitizedArgs = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
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

  return mcpServer;
}
