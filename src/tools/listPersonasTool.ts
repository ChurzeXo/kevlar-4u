import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadAllPersonas, Persona } from "../utils/parser.js";
import { PLATFORM_TO_EN } from "../utils/personaIdMaps.js";
import { ToolResult } from "../utils/types.js";
import type { ToolModule } from "./types.js";
import { getToolDescription, getListPersonasCount, getPlatformCount } from "../i18n/tools-i18n.js";
import { t, getCurrentLanguage } from "../i18n/index.js";

export const listPersonasToolDefinition: Tool = {
  name: "list_personas",
  description: getToolDescription("listPersonas"),
  inputSchema: {
    type: "object" as const,
    properties: {
      platform: {
        type: "string",
        description: t("listPersonas.platformDescription", { ns: "tools", defaultValue: "Platform name (e.g., 'Xiaohongshu', 'Zhihu'). No param → overview by platform; with platform name → list for that platform; 'all' → list all." }),
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
  return getCurrentLanguage() === "zh-CN" ? "通用" : "General";
}

function formatPersonaLines(
  name: string,
  description: string,
  tags: string[],
  plat: string,
): string[] {
  const locale = getCurrentLanguage();
  const tagLabel = locale === "zh-CN" ? "标签" : "Tags";
  return tags.length > 0
    ? [
        `- **${name}**（${plat}）— ${description}`,
        `  ${tagLabel}：${tags.map((t) => `\`${t}\``).join(" · ")}`,
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
  const locale = getCurrentLanguage();

  if (personas.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: t("listPersonas.emptyMessage", { ns: "tools", defaultValue: "⚠️ No reviewers available. You can create custom reviewers to start reviewing." }),
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
      `📊 ${getListPersonasCount(personas.length)}`,
      "",
    ];

    for (const plat of Object.keys(byPlatform).sort()) {
      lines.push(`- **${plat}**（${getPlatformCount(plat, byPlatform[plat].length)}）`);
    }

    const selectPlatformHint = locale === "zh-CN"
      ? "💡 请选择你要查看的平台（一次只能选择一个），\n例如：列出小红书的评审员 / 查看知乎的评审员"
      : "💡 Please select the platform you want to view (one at a time),\ne.g.: List Xiaohongshu reviewers / Show Zhihu reviewers";

    lines.push("", selectPlatformHint);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // "全部" or "all" → show all, grouped by platform
  if (platform === "全部" || platform.toLowerCase() === "all") {
    const allLabel = locale === "zh-CN" ? "所有评审员" : "All Reviewers";
    const lines: string[] = [
      `🎭 **${allLabel}**（${getListPersonasCount(personas.length)}）\n`,
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
    const noReviewersMsg = locale === "zh-CN"
      ? `❌ 平台「${platform}」没有评审员。\n\n现有平台：${Object.keys(byPlatform).sort().join("、")}。`
      : `❌ No reviewers for platform "${platform}".\n\nAvailable platforms: ${Object.keys(byPlatform).sort().join(", ")}.`;
    return {
      content: [
        {
          type: "text",
          text: noReviewersMsg,
        },
      ],
    };
  }

  const platformReviewersLabel = locale === "zh-CN" ? `${platform}评审员` : `${platform} Reviewers`;
  const lines: string[] = [
    `🎭 **${platformReviewersLabel}**（${getListPersonasCount(matched.length)}）\n`,
  ];

  for (const p of matched) {
    lines.push(...formatPersonaLines(
      p.meta.name, p.meta.description, p.meta.tags, platform,
    ), "");
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
