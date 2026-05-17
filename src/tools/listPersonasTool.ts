import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadAllPersonas } from "../utils/parser.js";

export const listPersonasToolDefinition: Tool = {
  name: "list_personas",
  description:
    "列出 Kevlar 当前可用的所有批评人设（性格角色）。在调用 review_content 之前，可以先调用此工具了解有哪些可用角色，或直接使用默认的全部角色。",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function handleListPersonas(
  skillsDir: string
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const personas = loadAllPersonas(skillsDir);

  if (personas.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "⚠️ 当前 skills/ 目录下没有找到任何有效的人设文件。请确认 skills/ 目录存在，且至少有一个非 _ 开头的 .md 文件。",
        },
      ],
    };
  }

  const lines: string[] = [
    `## 🎭 当前可用人设列表（共 ${personas.length} 个）\n`,
  ];

  for (const p of personas) {
    lines.push(`### \`${p.meta.id}\` — ${p.meta.name}`);
    if (p.meta.name_en) lines.push(`**English**: ${p.meta.name_en}`);
    lines.push(`**描述**: ${p.meta.description}`);
    if (p.meta.tags.length > 0) {
      lines.push(`**标签**: ${p.meta.tags.map((t) => `\`${t}\``).join(" · ")}`);
    }
    lines.push(`**版本**: v${p.meta.version} · **作者**: ${p.meta.author}`);
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "💡 **使用方式**：调用 `review_content` 时通过 `persona_ids` 参数指定角色 ID，或留空以使用全部角色。"
  );

  return {
    content: [
      {
        type: "text",
        text: lines.join("\n"),
      },
    ],
  };
}
