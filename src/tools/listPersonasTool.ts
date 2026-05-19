import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadAllPersonas } from "../utils/parser.js";
import { ToolResult } from "../utils/types.js";

export const listPersonasToolDefinition: Tool = {
  name: "list_personas",
  description:
    "列出 Kevlar 当前可用的所有批评人设（性格角色）。用户粘贴文案后，先调用此工具展示列表让用户挑选本次要激活的评论员（默认全选）。",
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
  lines.push("💡 告诉我你想激活哪些评论员，或直接说「全部」开始评测。");

  return {
    content: [
      {
        type: "text",
        text: lines.join("\n"),
      },
    ],
  };
}
