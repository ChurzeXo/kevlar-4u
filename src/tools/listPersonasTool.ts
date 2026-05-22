import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadAllPersonas } from "../utils/parser.js";
import { ToolResult } from "../utils/types.js";

export const listPersonasToolDefinition: Tool = {
  name: "list_personas",
  description:
    "列出 Kevlar 当前可用的所有批评人设（性格角色）。独立查询工具，不依赖内容评测流程。",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function handleListPersonas(
  skillsDir: string
): Promise<ToolResult> {
  const personas = await loadAllPersonas(skillsDir);

  if (personas.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "⚠️ 当前没有任何评论员可用。你可以创建自定义评论员来开始评测。",
        },
      ],
    };
  }

  const lines: string[] = [
    `🎭 **当前评论员**（共 ${personas.length} 位）\n`,
  ];

  for (const p of personas) {
    lines.push(`- **${p.meta.name}** — ${p.meta.description}`);
    if (p.meta.tags.length > 0) {
      lines.push(`  标签：${p.meta.tags.map((t) => `\`${t}\``).join(" · ")}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("💡 你可以创建新评论员，或开始内容评测。");

  return {
    content: [
      {
        type: "text",
        text: lines.join("\n"),
      },
    ],
  };
}
