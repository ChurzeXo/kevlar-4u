import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadAllPersonas, Persona } from "../utils/parser.js";
import { PLATFORM_TO_EN } from "../utils/personaIdMaps.js";
import { ToolResult } from "../utils/types.js";

export const listPersonasToolDefinition: Tool = {
  name: "list_personas",
  description:
    "当用户说「有哪些评论员」「列出角色」「显示评论员」时，调用此工具。查询可用评论员。不传 platform 参数时返回各平台评论员数量概览，AI 应据此询问用户想查看哪个平台的评论员。传入 platform 参数则返回该平台下的评论员列表。platform 值为中文平台名（如「小红书」「知乎」「通用」），或「全部」表示列出所有平台。独立查询，不触发评测流程。",
  inputSchema: {
    type: "object" as const,
    properties: {
      platform: {
        type: "string",
        description:
          "目标平台名称（中文，如「小红书」「知乎」「通用」）。不传时返回平台概览；传入「全部」列出所有评论员。",
      },
    },
    required: [],
  },
};

const KNOWN_PLATFORMS = Object.keys(PLATFORM_TO_EN);

function getPersonaPlatform(persona: Persona): string {
  for (const tag of persona.meta.tags) {
    if (KNOWN_PLATFORMS.includes(tag)) return tag;
  }
  for (const [name, key] of Object.entries(PLATFORM_TO_EN)) {
    if (persona.meta.id.includes(key)) return name;
  }
  return "通用";
}

export async function handleListPersonas(
  skillsDir: string,
  platform?: string
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

  // Group personas by platform
  const byPlatform: Record<string, Persona[]> = {};
  for (const p of personas) {
    const plat = getPersonaPlatform(p);
    if (!byPlatform[plat]) byPlatform[plat] = [];
    byPlatform[plat].push(p);
  }

  // No platform specified → show overview
  if (!platform) {
    const lines: string[] = [
      `📊 共有 ${personas.length} 位评论员，分布在以下平台：`,
      "",
    ];

    for (const [plat, list] of Object.entries(byPlatform).sort()) {
      lines.push(`- **${plat}**（${list.length} 位）`);
    }

    lines.push(
      "",
      "💡 请选择你要查看的平台（一次只能选择一个），",
      "例如：列出小红书的评论员 / 查看知乎的评论员",
    );

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }

  // "全部" → show all
  if (platform === "全部") {
    const lines: string[] = [
      `🎭 **所有评论员**（共 ${personas.length} 位）\n`,
    ];

    for (const p of personas) {
      const plat = getPersonaPlatform(p);
      lines.push(`- **${p.meta.name}**（${plat}）— ${p.meta.description}`);
      if (p.meta.tags.length > 0) {
        lines.push(`  标签：${p.meta.tags.map((t) => `\`${t}\``).join(" · ")}`);
      }
      lines.push("");
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }

  // Specific platform → filter
  const matched = byPlatform[platform];
  if (!matched || matched.length === 0) {
    const available = Object.keys(byPlatform).sort();
    return {
      content: [
        {
          type: "text",
          text: [
            `❌ 平台「${platform}」没有评论员。`,
            "",
            `现有平台：${available.join("、")}。`,
          ].join("\n"),
        },
      ],
    };
  }

  const lines: string[] = [
    `🎭 **${platform}评论员**（共 ${matched.length} 位）\n`,
  ];

  for (const p of matched) {
    lines.push(`- **${p.meta.name}** — ${p.meta.description}`);
    if (p.meta.tags.length > 0) {
      lines.push(`  标签：${p.meta.tags.map((t) => `\`${t}\``).join(" · ")}`);
    }
    lines.push("");
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}
