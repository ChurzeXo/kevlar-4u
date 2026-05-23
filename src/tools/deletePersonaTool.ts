import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import { loadPersonaById, validateWritePath, invalidatePersonasCache } from "../utils/parser.js";
import { ToolResult } from "../utils/types.js";
import type { ToolModule } from "./types.js";
import { getErrorInfo } from "../utils/observability.js";

export const deletePersonaToolDefinition: Tool = {
  name: "delete_persona",
  description:
    "删除一个已存在的批评人设。AI 会先列出所有评论员供用户选择，二次确认后执行删除。不能删除不存在的角色，不能撤销删除操作。必须先调 list_personas 获取可用列表供用户选择。",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: {
        type: "string",
        description: "要删除的人设 ID。必须先通过 list_personas 获取目标人设的 ID。",
      },
      confirm: {
        type: "boolean",
        description: "二次确认标志，必须为 true 才会执行删除",
      },
    },
    required: ["id", "confirm"],
  },
};

export const deletePersonaModule: ToolModule = {
  definition: deletePersonaToolDefinition,
  handler: (deps) => async (args) => {
    if (!args) throw new Error("删除评论员需要提供参数");
    const delInput = args as { id: string; confirm: boolean };
    if (!delInput.id) throw new Error("请指定要删除的评论员");
    return await handleDeletePersona(deps.skillsDir, delInput);
  },
};

export async function handleDeletePersona(
  skillsDir: string,
  input: { id: string; confirm: boolean }
): Promise<ToolResult> {
  if (!input.confirm) {
    return {
      content: [{ type: "text", text: "⚠️ 删除操作需要二次确认，请确认你要删除这个评论员。" }],
      isError: true,
    };
  }

  const persona = await loadPersonaById(skillsDir, input.id);
  if (!persona) {
    return {
      content: [{ type: "text", text: "❌ 找不到这个评论员。" }],
      isError: true,
    };
  }

  // Idempotency: check if already deleted
  if (!fs.existsSync(persona.filePath)) {
    return {
      content: [{ type: "text", text: "⚠️ 该评论员已被删除。" }],
    };
  }

  // Security check: validate path is within skillsDir
  if (!validateWritePath(persona.filePath, skillsDir)) {
    return {
      content: [{ type: "text", text: "❌ 非法路径访问被拒绝。" }],
      isError: true,
    };
  }

  try {
    await fs.promises.unlink(persona.filePath);
    invalidatePersonasCache();
  } catch (err) {
    const info = getErrorInfo(err);
    return {
      content: [{ type: "text", text: `❌ 删除文件失败：${info.message}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: `✅ 人设「${persona.meta.name}」已删除。` }],
  };
}
