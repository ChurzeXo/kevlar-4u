import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { loadPersonaById } from "../utils/parser.js";

export const deletePersonaToolDefinition: Tool = {
  name: "delete_persona",
  description:
    "删除一个已存在的批评人设。AI 会先列出所有评论员供用户选择，二次确认后执行删除。系统内置角色（作者为 kevlar-core 的）同样可以删除，之后可通过 reset_personas 恢复。",
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
): Promise<{ content: Array<{ type: string; text: string }> }> {
  if (!input.confirm) {
    return {
      content: [{ type: "text", text: "⚠️ 删除操作需要确认，请将 confirm 设为 true。" }],
    };
  }

  const persona = loadPersonaById(skillsDir, input.id);
  if (!persona) {
    return {
      content: [{ type: "text", text: `❌ 找不到人设 \`${input.id}\`。` }],
    };
  }

  const isBuiltIn = persona.meta.author === "kevlar-core";

  try {
    fs.unlinkSync(persona.filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `❌ 删除文件失败：${message}` }],
    };
  }

  const lines: string[] = [
    `✅ 人设「${persona.meta.name}」（\`${input.id}\`）已删除。`,
  ];

  if (isBuiltIn) {
    lines.push("");
    lines.push("📌 这是系统内置角色，如需恢复请执行 reset_personas。");
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}
