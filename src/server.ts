import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

import { createToolRegistry } from "./tools/index.js";
import type { ToolDependencies } from "./tools/types.js";
import { log } from "./utils/logCategories.js";
import { formatErrorResponse, internalError } from "./utils/errors.js";
import { formatErrorWithReportPrompt } from "./utils/errorReporting.js";
import { getErrorInfo } from "./utils/observability.js";
import { resolveSamplingFn } from "./execution/sampling.js";
import { setClientInfo, setClientCapabilities, setRawInitializeParams, setHandshakeDumpDir, getHostExecutionCapability } from "./execution/client.js";
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

const _serverVersion = (() => {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, "..");
    return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")).version;
  } catch {
    return "1.0.0";
  }
})();

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
    let files: string[];
    try {
      files = await fs.promises.readdir(tmpDir);
    } catch {
      return;
    }
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
            log.wizard.info("Cleaned stale wizard state", { event: "clean_stale_wizard", file });
          }
        } catch (err) {
          // JSON parse error or missing createdAt - clean up corrupted file
          try {
            await fs.promises.unlink(filePath);
            log.wizard.info("Cleaned corrupted wizard state", { event: "clean_corrupted_wizard", file });
          } catch {
            // Ignore cleanup errors
          }
        }
      })());
    }
    await Promise.all(deletePromises);
  } catch (err) {
    const info = getErrorInfo(err);
    log.wizard.warn("Failed to clean stale wizard states", { event: "clean_stale_wizards_error", error: info.code, message: info.message });
  }
}

function ensureSkillsDirectory(skillsDir: string) {
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
    log.system.info("Created skills directory", { event: "dir_created", path: skillsDir });
  } else {
    // log.system.info("Using skills directory", { event: "dir_using", path: skillsDir });
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
      log.sampling.error("Multi-turn Sampling request failed", {
        event: "multi_sampling_request_error",
        error: info.code,
        message: info.message,
        recoverable: info.recoverable,
      });
      throw internalError(`多轮 Sampling 调用失败: ${info.message}`);
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

export function announceHandshakeToClient(
  underlyingServer: any,
  clientName?: string,
  rawInitializeParams?: any,
): void {
  const clientVersion = underlyingServer.getClientVersion();
  const clientCaps = underlyingServer.getClientCapabilities();

  // Prefer raw intercepted params (reliable) over SDK getters (may return null)
  const effectiveClientName = rawInitializeParams?.clientInfo?.name
    ?? clientVersion?.name
    ?? clientName
    ?? "unknown";
  const effectiveClientVersion = rawInitializeParams?.clientInfo?.version
    ?? clientVersion?.version
    ?? "unknown";
  const effectiveClientCaps = rawInitializeParams?.capabilities
    ?? clientCaps
    ?? null;

  // Populate the execution-layer capability cache so isSamplingSupported() etc. work
  if (clientVersion) {
    setClientInfo(clientVersion.name, clientVersion.version);
  }
  if (effectiveClientCaps) {
    setClientCapabilities(effectiveClientCaps as Record<string, unknown>);
  }
  if (rawInitializeParams) {
    setRawInitializeParams(rawInitializeParams);
  }

  // Write host-exec-handshake.json dump immediately during handshake
  // (not lazily during first tool invocation), so the file is always
  // fresh after every client reconnect.
  getHostExecutionCapability();

  // Structured log event (debug level — viewable in client logs, not UI)
  log.handshake.debug("Client handshake complete", {
    event: "client_handshake",
    clientName: effectiveClientName,
    clientVersion: effectiveClientVersion,
    capabilities: effectiveClientCaps ? Object.keys(effectiveClientCaps) : [],
    hasSampling: !!(effectiveClientCaps as any)?.sampling,
    hasTaskAugmented: !!(effectiveClientCaps as any)?.tasks?.requests?.sampling?.createMessage,
    hasTaskCancel: !!(effectiveClientCaps as any)?.tasks?.cancel,
    hasHostExec: !!(effectiveClientCaps as any)?.experimental?.["kevlar.host.execution/v1"],
  });

  // Send capability summary to client via logging notification
  const capabilityKeys = effectiveClientCaps ? Object.keys(effectiveClientCaps) : [];
  const samplingCap = !!(effectiveClientCaps as any)?.sampling;
  const taskAugCap = !!(effectiveClientCaps as any)?.tasks?.requests?.sampling?.createMessage;
  const taskCancelCap = !!(effectiveClientCaps as any)?.tasks?.cancel;

  const summary = [
    `[Kevlar-4u] ✅ Handshake complete with ${effectiveClientName} v${effectiveClientVersion}`,
    `Capabilities: ${capabilityKeys.length ? capabilityKeys.join(", ") : "(none)"}`,
    `sampling.createMessage = ${samplingCap ? "✅" : "❌"} (serial)`,
    `tasks.requests.sampling.createMessage = ${taskAugCap ? "✅" : "❌"} (parallel)`,
    `tasks.cancel = ${taskCancelCap ? "✅" : "❌"}`,
  ].join("\n");

  // No longer write to stderr — use MCP logging notification below
  // writeRawStderr(summary);

  try {
    const result = underlyingServer.sendLoggingMessage({
      level: "debug",
      logger: "kevlar-handshake",
      data: summary,
    });
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch {
    // Client may not support logging — ignore
  }

}

let _initialized = false;

export function setServerInitialized(): void {
  _initialized = true;
}

export function isServerInitialized(): boolean {
  return _initialized;
}

export function _resetServerInitializedForTest(): void {
  _initialized = false;
}

function assertInitialized(): void {
  if (!_initialized) {
    throw new McpError(-32002, "Server not initialized");
  }
}

function setupListToolsHandler(
  underlyingServer: any,
  toolDefinitions: any[],
) {
  underlyingServer.setRequestHandler(ListToolsRequestSchema, async () => {
    assertInitialized();
    return { tools: toolDefinitions };
  });
}

function setupCallToolHandler(
  underlyingServer: any,
  registry: Map<string, any>,
) {
  underlyingServer.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    assertInitialized();

    const { name, arguments: args } = request.params;
    const startTime = Date.now();

    log.tool.debug("Tool call received", { event: "tool_called", tool: name });

    try {
      const sanitizedArgs = args && typeof args === "object"
        ? (args as Record<string, unknown>)
        : undefined;
      const handler = registry.get(name);
      if (!handler) {
        log.tool.warn("Unknown tool requested", { event: "unknown_tool", tool: name });
        throw internalError(`Unknown tool: ${name}`);
      }
      const result = await handler(sanitizedArgs);
      log.tool.info("Tool completed", {
        event: "tool_completed",
        tool: name,
        durationMs: Date.now() - startTime,
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const info = getErrorInfo(err);
      log.tool.error("Tool execution failed", {
        event: "tool_error",
        tool: name,
        error: info.code,
        message: info.message,
        recoverable: info.recoverable,
        durationMs,
      });
      const rawMessage = formatErrorResponse(err).content?.[0]?.text ?? `❌ ${info.message}`;
      const reportedMessage = formatErrorWithReportPrompt(rawMessage, name);
      return {
        content: [{ type: "text" as const, text: reportedMessage }],
        isError: true,
      };
    }
  });
}

export async function createKevlarServer(): Promise<McpServer> {
  const skillsDir = resolveSkillsDir();
  const tmpDir = path.join(skillsDir, "tmp");

  setConfigPath(skillsDir);
  setObservationCacheDir(tmpDir);
  setHandshakeDumpDir(tmpDir);
  ensureSkillsDirectory(skillsDir);
  cleanStaleDrafts(tmpDir).catch(() => {});

  const mcpServer = new McpServer(
    {
      name: "kevlar-4u",
      title: "Kevlar-4u 内容风险评测系统",
      version: _serverVersion,
    },
    {
      capabilities: {
        tools: { listChanged: true },
        logging: {},
        experimental: {
          "kevlar.host.execution/v1": {
            version: "1.0.0",
            ephemeralAgents: { supported: true },
            orchestration: { supported: true },
          },
          tasks: {
            list: {},
            cancel: {},
            requests: {
              tools: { call: {} },
            },
          },
        },
      },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  const underlyingServer = mcpServer.server;

  // Hook the SDK's lifecycle callback so _initialized flips even
  // in environments where src/index.ts transport intercept is absent (e.g. E2E tests).
  underlyingServer.oninitialized = () => {
    setServerInitialized();
  };
  const deps = await buildToolDependencies(skillsDir, tmpDir, underlyingServer);
  const { registry, toolDefinitions } = createToolRegistry(deps);

  setupListToolsHandler(underlyingServer, toolDefinitions);
  setupCallToolHandler(underlyingServer, registry);

  return mcpServer;
}
