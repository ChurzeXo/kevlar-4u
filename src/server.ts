import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

import {
  listPersonasToolDefinition,
  handleListPersonas,
  createPersonaToolDefinition,
  updatePersonaDraftToolDefinition,
  handleUpdatePersonaDraft,
  deletePersonaDraftToolDefinition,
  handleDeletePersonaDraft,
  UpdatePersonaDraftInput,
  DeletePersonaDraftInput,
  handleCreatePersona,
  reviewToolDefinition,
  handleReviewContent,
  deletePersonaToolDefinition,
  handleDeletePersona,
  deletePersonaWizardToolDefinition,
  handleDeletePersonaWizard,
  DeletePersonaWizardInput,
  resetPersonasToolDefinition,
  handleResetPersonas,
  resetPersonasWizardToolDefinition,
  handleResetPersonasWizard,
  ResetPersonasWizardInput,
  helpToolDefinition,
  handleHelp,
  getModesToolDefinition,
  handleGetModes,
  configureToolDefinition,
  handleConfigure,
  CreatePersonaInput,
  ReviewInput,
  ConfigureInput,
  configureWizardToolDefinition,
  handleConfigureWizard,
  ConfigureWizardInput,
  createPersonaWizardToolDefinition,
  handleCreatePersonaWizard,
  WizardInput,
  reviewContentWizardToolDefinition,
  handleReviewContentWizard,
  ReviewWizardInput,
} from "./tools/index.js";
import { REVIEW_DISPATCHER_PROMPT } from "./prompts/reviewDispatcherPrompt.js";
import { logger } from "./utils/logger.js";
import { formatErrorResponse, isKevlarError } from "./utils/errors.js";
import { isSamplingSupported, setClientInfo } from "./execution/client.js";
import { setConfigPath } from "./execution/config.js";
import type { SamplingFunction, MultiTurnSamplingFunction } from "./execution/base.js";

// ── Resolve the skills/ directory ────────────────────────────────────────────
// Priority:
//   1. KEVLAR_SKILLS_DIR environment variable (absolute path)
//   2. <repo-root>/skills/  (relative to this file's compiled location)
function resolveSkillsDir(): string {
  if (process.env.KEVLAR_SKILLS_DIR) {
    return path.resolve(process.env.KEVLAR_SKILLS_DIR);
  }
  // __dirname equivalent in ESM
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // dist/ after compilation; go up one level to repo root
  const repoRoot = path.resolve(__dirname, "..");
  return path.join(repoRoot, "skills");
}

// ─────────────────────────────────────────────────────────────────────────────


// ── Clean Stale Drafts ───────────────────────────────────────────────────────
async function cleanStaleDrafts(tmpDir: string) {
  try {
    if (!fs.existsSync(tmpDir)) return;
    const files = await fs.promises.readdir(tmpDir);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith('_draft.json')) continue;
      const filePath = path.join(tmpDir, file);
      try {
        const data = await fs.promises.readFile(filePath, 'utf-8');
        const draft = JSON.parse(data);
        if (draft.createdAt && now - draft.createdAt > 86400000) {
          await fs.promises.unlink(filePath);
          logger.info("Cleaned stale draft", { event: "clean_stale_draft", file });
        }
      } catch (err) {
        // Ignore parsing errors for individual files
      }
    }
  } catch (err) {
    logger.warn("Failed to clean stale drafts", { event: "clean_stale_drafts_error", error: String(err) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export function createKevlarServer(): Server {
  const skillsDir = resolveSkillsDir();
  const tmpDir = path.join(skillsDir, "tmp");

  // Initialize config path
  setConfigPath(skillsDir);

  // Ensure skills directory exists on startup (sync for initialization)
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
    logger.info("Created skills directory", { event: "dir_created", path: skillsDir });
  } else {
    logger.info("Using skills directory", { event: "dir_using", path: skillsDir });
  }

  // Background cleanup of stale drafts
  cleanStaleDrafts(tmpDir).catch(() => {});

  const server = new Server(
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

  const updateClientSamplingSupport = (): boolean => {
    const clientVersion = server.getClientVersion();
    if (clientVersion) {
      setClientInfo(clientVersion.name, clientVersion.version);
      return isSamplingSupported(clientVersion.name);
    }
    return false;
  };

  // ── Create sampling function for MCP Sampling mode ─────────────────────────
  const createSamplingFn = (serverInstance: Server): SamplingFunction => {
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

  // ── Create multi-turn sampling function for MCP Sampling Wizards ─────────────
  const createMultiTurnSamplingFn = (serverInstance: Server): MultiTurnSamplingFunction => {
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

  // ── Tool: list tools ────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        listPersonasToolDefinition,
        createPersonaToolDefinition,
        updatePersonaDraftToolDefinition,
        deletePersonaDraftToolDefinition,
        deletePersonaToolDefinition,
        deletePersonaWizardToolDefinition,
        resetPersonasToolDefinition,
        resetPersonasWizardToolDefinition,
        reviewToolDefinition,
        getModesToolDefinition,
        configureToolDefinition,
        configureWizardToolDefinition,
        helpToolDefinition,
        createPersonaWizardToolDefinition,
        reviewContentWizardToolDefinition,
      ],
    };
  });

  // ── Tool: dispatch calls ────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    logger.debug("Tool call received", { event: "tool_called", tool: name });

    try {
      switch (name) {
        case "list_personas": {
          return await handleListPersonas(skillsDir);
        }

                case "update_persona_draft": {
          if (!args || typeof args !== "object") throw new Error("需要提供参数");
          return await handleUpdatePersonaDraft(tmpDir, args as unknown as UpdatePersonaDraftInput);
        }

        case "delete_persona_draft": {
          if (!args || typeof args !== "object") throw new Error("需要提供参数");
          return await handleDeletePersonaDraft(tmpDir, args as unknown as DeletePersonaDraftInput);
        }

        case "create_persona": {
          if (!args || typeof args !== "object") {
            throw new Error("创建评论员需要提供参数");
          }
          return await handleCreatePersona(skillsDir, tmpDir, args as unknown as CreatePersonaInput);
        }

        case "create_persona_wizard": {
          if (!args || typeof args !== "object") {
            throw new Error("向导需要提供参数");
          }
          const input = args as unknown as WizardInput;
          if (updateClientSamplingSupport()) {
            input.samplingFn = createMultiTurnSamplingFn(server);
          }
          
          return await handleCreatePersonaWizard(skillsDir, tmpDir, input);
        }

        case "delete_persona": {
          if (!args || typeof args !== "object") {
            throw new Error("删除评论员需要提供参数");
          }
          const delInput = args as unknown as { id: string; confirm: boolean };
          if (!delInput.id) {
            throw new Error("请指定要删除的评论员");
          }
          return await handleDeletePersona(skillsDir, delInput);
        }

        case "delete_persona_wizard": {
          if (!args || typeof args !== "object") {
            throw new Error("删除向导需要提供参数");
          }
          return await handleDeletePersonaWizard(skillsDir, tmpDir, args as unknown as DeletePersonaWizardInput);
        }

        case "reset_personas": {
          if (!args || typeof args !== "object") {
            throw new Error("恢复操作需要提供参数");
          }
          const resetInput = args as unknown as { confirm: boolean };
          return await handleResetPersonas(skillsDir, resetInput);
        }

        case "reset_personas_wizard": {
          if (!args || typeof args !== "object") {
            throw new Error("恢复向导需要提供参数");
          }
          return await handleResetPersonasWizard(skillsDir, tmpDir, args as unknown as ResetPersonasWizardInput);
        }

        case "review_content": {
          if (!args || typeof args !== "object") {
            throw new Error("评测需要提供文案内容");
          }
          const input = args as unknown as ReviewInput;
          
          const samplingSupported = updateClientSamplingSupport();
          
          // Inject sampling function for MCP Sampling mode
          if (samplingSupported) {
            input.samplingFn = createSamplingFn(server);
          }
          
          return await handleReviewContent(skillsDir, input);
        }

        case "review_content_wizard": {
          if (!args || typeof args !== "object") {
            throw new Error("向导需要提供参数");
          }
          const input = args as unknown as ReviewWizardInput;
          if (updateClientSamplingSupport()) {
            input.samplingFn = createMultiTurnSamplingFn(server);
          }
          
          return await handleReviewContentWizard(skillsDir, tmpDir, input);
        }

        case "get_execution_modes": {
          return await handleGetModes();
        }

        case "configure": {
          if (!args || typeof args !== "object") {
            throw new Error("配置需要提供参数");
          }
          const configureInput = args as unknown as ConfigureInput;
          return await handleConfigure(configureInput);
        }

        case "configure_wizard": {
          if (!args || typeof args !== "object") {
            throw new Error("配置向导需要提供参数");
          }
          return await handleConfigureWizard(tmpDir, args as unknown as ConfigureWizardInput);
        }

        case "kevlar_help": {
          return await handleHelp();
        }

        default: {
          logger.warn("Unknown tool requested", { event: "unknown_tool", tool: name });
          throw new Error(`Unknown tool: ${name}`);
        }
      }
    } catch (err) {
      logger.error("Tool execution failed", {
        event: "tool_error",
        tool: name,
        error: isKevlarError(err) ? err.code : "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
      return formatErrorResponse(err);
    }
  });

  // ── Prompts: list prompts ───────────────────────────────────────────────
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: "create_persona",
          title: "虚拟读者人设搭建系统 (Legacy Fallback)",
          description: "【仅用于不支持 Sampling 的旧版客户端的降级方案】引导用户以阶段式对话收集输入，并创建高精度评论员人设的系统提示词",
        },
        {
          name: "review_content",
          title: "内容评测调度引擎 (Legacy Fallback)",
          description: "【仅用于不支持 Sampling 的旧版客户端的降级方案】分析用户提交的内容并匹配最合适的评论员进行内容评测的系统提示词",
        }
      ]
    };
  });

  // ── Prompts: get prompt ──────────────────────────────────────────────────
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: promptArgs } = request.params;
    if (name === "create_persona") {
      const args = (promptArgs || {}) as Record<string, string>;
      const currentStep = args.currentStep || "ageRange";
      const sessionId = args.sessionId || "未开始";
      const knownFields = args.knownFields || "none";
      return {
        description:
          "【降级方案】启动或恢复 Kevlar 人设创建工作流的动态上下文提示",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "你正在协助执行 Kevlar 的 create_persona 工作流。",
                "不要自行扮演完整的角色构建引擎；流程状态、字段校验和写入由 Kevlar 工具负责。",
                "",
                `sessionId: ${sessionId}`,
                `currentStep: ${currentStep}`,
                `knownFields: ${knownFields}`,
                "",
                "下一步：调用 create_persona_wizard 工具，并把用户回复作为 userMessage 传入。",
                "工具返回 assistantMessage 后，将其展示给用户；用户继续回复时，带上同一个 sessionId 再次调用 create_persona_wizard。",
                "禁止：不要跳过确认步骤，不要直接调用 create_persona，除非 create_persona_wizard 已完成最终创建。",
              ].join("\n"),
            },
          },
        ],
      };
    } else if (name === "review_content") {
      return {
        description: "【降级方案】分析用户提交的内容并匹配最合适的评论员进行内容评测的系统提示词",
        messages: [
          {
            role: "assistant",
            content: { type: "text", text: REVIEW_DISPATCHER_PROMPT }
          }
        ]
      };
    }
    throw new Error(`Unknown prompt: ${name}`);
  });

  return server;
}
