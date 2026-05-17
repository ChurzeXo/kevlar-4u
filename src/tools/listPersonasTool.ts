import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadAllPersonas } from "../utils/parser.js";

export const listPersonasToolDefinition: Tool = {
  name: "list_personas",
  description:
    "列出 Kevlar 当前可用的所有批评人设（性格角色）。用户粘贴文案后，必须先调用此工具展示列表让用户挑选本次要激活的评论员（默认全选），再将选中的 ID 传给 review_content 的 persona_ids 参数。支持多选和全选/反选。",
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

  const allIds = personas.map((p) => p.meta.id);

  const lines: string[] = [
    `## 🎭 当前可用人设列表（共 ${personas.length} 个）\n`,
    "**选择指南**：请告诉用户以下可用评论员，让用户勾选本次要激活的角色（默认全选）。",
    `**全部 ID**：${allIds.map((id) => `\`${id}\``).join(", ")}`,
    "",
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
    "💡 **使用方式**：展示列表让用户勾选（默认全选），然后将所选 ID 传入 `review_content` 的 `persona_ids` 参数。如果不指定 `persona_ids` 则使用全部角色。"
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
