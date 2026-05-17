import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import { loadPersonaById, validateWritePath, invalidatePersonasCache } from "../utils/parser.js";
import { ToolResult } from "../utils/types.js";

export const deletePersonaToolDefinition: Tool = {
  name: "delete_persona",
  description:
    "删除一个已存在的批评人设。AI 会先列出所有评论员供用户选择，二次确认后执行删除。系统内置角色同样可以删除，之后可以恢复。",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: {
        type: "string",
        description: "要删除的人设 ID",
      },
      confirm: {
        type: "boolean",
        description: "二次确认标志，必须为 true 才会执行删除",
      },
    },
    required: ["id", "confirm"],
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

  const isBuiltIn = persona.meta.author === "kevlar-core";

  try {
    await fs.promises.unlink(persona.filePath);
    invalidatePersonasCache();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `❌ 删除文件失败：${message}` }],
      isError: true,
    };
  }

  const lines: string[] = [
    `✅ 人设「${persona.meta.name}」已删除。`,
  ];

  if (isBuiltIn) {
    lines.push("");
    lines.push("📌 这是系统内置角色，如需恢复可以告诉我。");
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}
