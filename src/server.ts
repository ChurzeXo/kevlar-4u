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

  // Ensure skills directory exists on startup
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
    console.error(`[Kevlar] Created skills directory at: ${skillsDir}`);
  } else {
    console.error(`[Kevlar] Using skills directory: ${skillsDir}`);
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

    try {
      switch (name) {
        case "list_personas": {
          return await handleListPersonas(skillsDir);
        }

        case "create_persona": {
          if (!args || typeof args !== "object") {
            throw new Error("create_persona requires arguments");
          }
          return await handleCreatePersona(skillsDir, args as unknown as CreatePersonaInput);
        }

        case "delete_persona": {
          if (!args || typeof args !== "object") {
            throw new Error("delete_persona requires arguments");
          }
          const delInput = args as unknown as { id: string; confirm: boolean };
          if (!delInput.id) {
            throw new Error("delete_persona requires a `id` string");
          }
          return await handleDeletePersona(skillsDir, delInput);
        }

        case "reset_personas": {
          if (!args || typeof args !== "object") {
            throw new Error("reset_personas requires arguments");
          }
          const resetInput = args as unknown as { confirm: boolean };
          return await handleResetPersonas(skillsDir, resetInput);
        }

        case "review_content": {
          if (!args || typeof args !== "object") {
            throw new Error("review_content requires arguments");
          }
          const input = args as unknown as ReviewInput;
          if (!input.content || typeof input.content !== "string") {
            throw new Error("review_content requires a non-empty `content` string");
          }
          return await handleReviewContent(skillsDir, input);
        }

        case "kevlar_help": {
          return await handleHelp();
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `❌ Kevlar 内部错误：${message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
