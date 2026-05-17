import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

import {
  listPersonasToolDefinition,
  handleListPersonas,
  createPersonaToolDefinition,
  handleCreatePersona,
  reviewToolDefinition,
  handleReviewContent,
  deletePersonaToolDefinition,
  handleDeletePersona,
  resetPersonasToolDefinition,
  handleResetPersonas,
  helpToolDefinition,
  handleHelp,
  CreatePersonaInput,
  ReviewInput,
} from "./tools/index.js";
import { logger } from "./utils/logger.js";
import { formatErrorResponse, isKevlarError } from "./utils/errors.js";

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

export function createKevlarServer(): Server {
  const skillsDir = resolveSkillsDir();

  // Ensure skills directory exists on startup (sync for initialization)
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
    logger.info("Created skills directory", { event: "dir_created", path: skillsDir });
  } else {
    logger.info("Using skills directory", { event: "dir_using", path: skillsDir });
  }

  const server = new Server(
    {
      name: "kevlar",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ── Tool: list tools ────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        listPersonasToolDefinition,
        createPersonaToolDefinition,
        deletePersonaToolDefinition,
        resetPersonasToolDefinition,
        reviewToolDefinition,
        helpToolDefinition,
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

        case "create_persona": {
          if (!args || typeof args !== "object") {
            throw new Error("创建评论员需要提供参数");
          }
          return await handleCreatePersona(skillsDir, args as unknown as CreatePersonaInput);
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

        case "reset_personas": {
          if (!args || typeof args !== "object") {
            throw new Error("恢复操作需要提供参数");
          }
          const resetInput = args as unknown as { confirm: boolean };
          return await handleResetPersonas(skillsDir, resetInput);
        }

        case "review_content": {
          if (!args || typeof args !== "object") {
            throw new Error("评测需要提供文案内容");
          }
          const input = args as unknown as ReviewInput;
          return await handleReviewContent(skillsDir, input);
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

  return server;
}
