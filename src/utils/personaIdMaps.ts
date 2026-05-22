export const TRAIT_SHORT_TO_EN: Record<string, string> = {
  "理性分析型": "analytical",
  "理性分析": "analytical",
  "感性跟风型": "trend_follower",
  "感性跟风": "trend_follower",
  "毒舌批评型": "critical",
  "毒舌批评": "critical",
  "实用主义型": "pragmatic",
  "实用主义": "pragmatic",
  "乐观积极型": "optimistic",
  "乐观积极": "optimistic",
  "严谨挑剔型": "meticulous",
  "严谨挑剔": "meticulous",
  "技术导向型": "tech_oriented",
  "技术导向": "tech_oriented",
  "创意灵感型": "creative",
  "创意灵感": "creative",
};

export const PLATFORM_TO_EN: Record<string, string> = {
  "小红书": "xiaohongshu",
  "抖音": "douyin",
  "微博": "weibo",
  "B站": "bilibili",
  "Bilibili": "bilibili",
  "知乎": "zhihu",
  "Twitter": "twitter",
  "X": "x",
  "微信": "wechat",
  "微信公众号": "wechat_official",
  "通用": "general",
  "Instagram": "instagram",
  "Reddit": "reddit",
  "YouTube": "youtube",
};

export function extractShortTrait(traitFull: string): string {
  const idx = traitFull.indexOf("→");
  return idx > 0 ? traitFull.substring(0, idx).trim() : traitFull.trim();
}

export function mapTraitToKey(traitShort: string): string | undefined {
  return TRAIT_SHORT_TO_EN[traitShort];
}

export function mapPlatformToKey(platform: string): string | undefined {
  return PLATFORM_TO_EN[platform];
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}
