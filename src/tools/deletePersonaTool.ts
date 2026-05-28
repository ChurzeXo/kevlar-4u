import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadPersonaById, deletePersonaFromJson, invalidatePersonasCache } from "../utils/parser.js";
import { ToolResult } from "../utils/types.js";
import type { ToolModule } from "./types.js";
import { getErrorInfo } from "../utils/observability.js";

export const deletePersonaToolDefinition: Tool = {
  name: "delete_persona",
  description:
    "删除一个已存在的评审员（评论区模拟器中的删除功能）。AI 会先列出所有评审员供用户选择，二次确认后执行删除。不能删除不存在的角色，不能撤销删除操作。必须先调 list_personas 获取可用列表供用户选择。",
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
    if (!args) throw new Error("删除评审员需要提供参数");
    const delInput = args as { id: string; confirm: boolean };
    if (!delInput.id) throw new Error("请指定要删除的评审员");
    return await handleDeletePersona(deps.skillsDir, delInput);
  },
};

export async function handleDeletePersona(
  skillsDir: string,
  input: { id: string; confirm: boolean }
): Promise<ToolResult> {
  if (!input.confirm) {
    return {
      content: [{ type: "text", text: "⚠️ 删除操作需要二次确认，请确认你要删除这个评审员。" }],
      isError: true,
    };
  }

  const persona = await loadPersonaById(skillsDir, input.id);
  if (!persona) {
    return {
      content: [{ type: "text", text: "❌ 找不到这个评审员。" }],
      isError: true,
    };
  }

  try {
    const deleted = await deletePersonaFromJson(skillsDir, input.id);
    if (!deleted) {
      return {
        content: [{ type: "text", text: "⚠️ 该评审员已被删除。" }],
      };
    }
    invalidatePersonasCache();
  } catch (err) {
    const info = getErrorInfo(err);
    return {
      content: [{ type: "text", text: `❌ 删除失败：${info.message}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: `✅ 人设「${persona.meta.name}」已删除。` }],
  };
}
