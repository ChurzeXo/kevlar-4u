import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadAllPersonas, Persona } from "../utils/parser.js";
import { PLATFORM_TO_EN } from "../utils/personaIdMaps.js";
import { ToolResult } from "../utils/types.js";
import type { ToolModule } from "./types.js";

export const listPersonasToolDefinition: Tool = {
  name: "list_personas",
  description:
    "当用户想查看已有评审员列表时调用（如「有哪些评审员」「列出角色」）。\n\n行为：\n- 不传 platform → 返回各平台评审员数量概览 → 你应据此询问用户想看哪个平台\n- 传入中文平台名（如「小红书」「知乎」）→ 列出该平台下的评审员\n- 传入「全部」 → 列出所有平台的全部评审员\n\n纯查询工具，不触发评审流程。",
  inputSchema: {
    type: "object" as const,
    properties: {
      platform: {
        type: "string",
        description:
          "中文平台名（如「小红书」「知乎」）。不传 → 各平台数量概览；传平台名 → 该平台列表；传「全部」 → 全部列出。",
      },
    },
    required: [],
  },
};

const KNOWN_PLATFORMS = new Set(Object.keys(PLATFORM_TO_EN));

function getPersonaPlatform(persona: Persona): string {
  const { tags, id } = persona.meta;
  for (const tag of tags) {
    if (KNOWN_PLATFORMS.has(tag)) return tag;
  }
  for (const [name, key] of Object.entries(PLATFORM_TO_EN)) {
    if (id.includes(key)) return name;
  }
  return "通用";
}

function formatPersonaLines(
  name: string,
  description: string,
  tags: string[],
  plat: string,
): string[] {
  return tags.length > 0
    ? [
        `- **${name}**（${plat}）— ${description}`,
        `  标签：${tags.map((t) => `\`${t}\``).join(" · ")}`,
      ]
    : [`- **${name}**（${plat}）— ${description}`];
}

export const listPersonasModule: ToolModule = {
  definition: listPersonasToolDefinition,
  handler: (deps) => async (args) => {
    const platform = args?.platform as string | undefined;
    return await handleListPersonas(deps.skillsDir, platform);
  },
};

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
          text: "⚠️ 当前没有任何评审员可用。你可以创建自定义评审员来开始评测。",
        },
      ],
    };
  }

  // Compute platform once per persona, cache for all branches
  const byPlatform: Record<string, Persona[]> = {};
  for (const p of personas) {
    const plat = getPersonaPlatform(p);
    (byPlatform[plat] ??= []).push(p);
  }

  // No platform specified → show overview
  if (!platform) {
    const lines: string[] = [
      `📊 共有 ${personas.length} 位评审员，分布在以下平台：`,
      "",
    ];

    for (const plat of Object.keys(byPlatform).sort()) {
      lines.push(`- **${plat}**（${byPlatform[plat].length} 位）`);
    }

    lines.push(
      "",
      "💡 请选择你要查看的平台（一次只能选择一个），",
      "例如：列出小红书的评审员 / 查看知乎的评审员",
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // "全部" → show all, grouped by platform
  if (platform === "全部") {
    const lines: string[] = [
      `🎭 **所有评审员**（共 ${personas.length} 位）\n`,
    ];

    for (const [plat, list] of Object.entries(byPlatform).sort()) {
      for (const p of list) {
        lines.push(...formatPersonaLines(
          p.meta.name, p.meta.description, p.meta.tags, plat,
        ), "");
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Specific platform → filter
  const matched = byPlatform[platform];
  if (!matched) {
    return {
      content: [
        {
          type: "text",
          text: [
            `❌ 平台「${platform}」没有评审员。`,
            "",
            `现有平台：${Object.keys(byPlatform).sort().join("、")}。`,
          ].join("\n"),
        },
      ],
    };
  }

  const lines: string[] = [
    `🎭 **${platform}评审员**（共 ${matched.length} 位）\n`,
  ];

  for (const p of matched) {
    lines.push(...formatPersonaLines(
      p.meta.name, p.meta.description, p.meta.tags, platform,
    ), "");
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
