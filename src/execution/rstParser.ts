/**
 * Natural Language RST Parser
 *
 * Parses user's natural language description of desired reviewer style
 * into a structured RSTConfig. Uses keyword matching to extract:
 *   - L1 Archetype
 *   - L2 Triggers
 *   - L3 Regional Pack
 *   - L4 Platform Culture
 */

import type { RSTConfig, ArchetypeId, TriggerId, RegionalPackId, PlatformCultureId } from "./dimensions.js";
import { RST_ARCHETYPES, RST_TRIGGERS, RST_REGIONAL_PACKS, RST_PLATFORM_CULTURES } from "./dimensions.js";

// ── Keyword Mappings ──────────────────────────────────────────────────────

/** Archetype keyword → ArchetypeId mapping */
const ARCHETYPE_KEYWORDS: Record<string, ArchetypeId[]> = {
	// 实用主义消费者
	"实用": ["pragmatic_consumer"],
	"性价比": ["pragmatic_consumer"],
	"价格": ["pragmatic_consumer"],
	"值不值": ["pragmatic_consumer"],
	"功能": ["pragmatic_consumer"],
	"功能党": ["pragmatic_consumer"],
	"实用主义": ["pragmatic_consumer"],

	// 技术真实性审查者
	"技术": ["technical_reviewer"],
	"代码": ["technical_reviewer"],
	"架构": ["technical_reviewer"],
	"实现": ["technical_reviewer"],
	"程序员": ["technical_reviewer"],
	"技术宅": ["technical_reviewer"],
	"技术控": ["technical_reviewer"],
	"developer": ["technical_reviewer"],
	"hacker": ["technical_reviewer"],

	// 注意力稀缺型路人
	"路人": ["low_attention_reader"],
	"没耐心": ["low_attention_reader"],
	"快速": ["low_attention_reader"],
	"碎片": ["low_attention_reader"],
	"随便看看": ["low_attention_reader"],
	"划走": ["low_attention_reader"],
	"注意力短": ["low_attention_reader"],

	// 反营销敏感者
	"反营销": ["anti_marketing_detector"],
	"营销": ["anti_marketing_detector"],
	"广告": ["anti_marketing_detector"],
	"推广": ["anti_marketing_detector"],
	"种草": ["anti_marketing_detector"],
	"带货": ["anti_marketing_detector"],
	"商业味": ["anti_marketing_detector"],
	"anti-marketing": ["anti_marketing_detector"],

	// 情绪直觉型用户
	"情绪": ["emotional_reactor"],
	"感觉": ["emotional_reactor"],
	"直觉": ["emotional_reactor"],
	"感性": ["emotional_reactor"],
	"情绪化": ["emotional_reactor"],
	"感受": ["emotional_reactor"],
	"feeling": ["emotional_reactor"],

	// 逻辑漏洞猎手
	"逻辑": ["logic_hunter"],
	"找茬": ["logic_hunter"],
	"挑刺": ["logic_hunter"],
	"漏洞": ["logic_hunter"],
	"矛盾": ["logic_hunter"],
	"杠": ["logic_hunter"],
	"杠精": ["logic_hunter"],
	"逻辑控": ["logic_hunter"],

	// 社会价值观察者
	"社会": ["social_value_observer"],
	"公共": ["social_value_observer"],
	"价值观": ["social_value_observer"],
	"社会责任": ["social_value_observer"],
	"群体": ["social_value_observer"],
	"影响": ["social_value_observer"],
	"公益": ["social_value_observer"],

	// 亚文化圈层守门人
	"圈层": ["subculture_gatekeeper"],
	"亚文化": ["subculture_gatekeeper"],
	"原教旨": ["subculture_gatekeeper"],
	"守门人": ["subculture_gatekeeper"],
	"纯度": ["subculture_gatekeeper"],
	"蹭": ["subculture_gatekeeper"],
	"入圈": ["subculture_gatekeeper"],
	"core": ["subculture_gatekeeper"],
};

/** Trigger keyword → TriggerId mapping */
const TRIGGER_KEYWORDS: Record<string, TriggerId[]> = {
	// 表达类
	"黑话": ["jargon_density"],
	"术语": ["jargon_density"],
	"行话": ["jargon_density"],
	"jargon": ["jargon_density"],
	"AI味": ["ai_writing"],
	"AI写": ["ai_writing"],
	"模板": ["ai_writing"],
	"套路": ["ai_writing"],
	"说教": ["preachy_tone"],
	"爹味": ["preachy_tone"],
	"居高临下": ["preachy_tone"],
	"教育人": ["preachy_tone"],
	"装腔": ["pretentious"],
	"做作": ["pretentious"],
	"矫情": ["pretentious"],
	"凡尔赛": ["pretentious", "class_expression"],
	"装逼": ["pretentious"],

	// 传播类
	"标题党": ["clickbait"],
	"夸张标题": ["clickbait"],
	"标题骗人": ["clickbait"],
	"拖沓": ["slow_pacing"],
	"冗长": ["slow_pacing"],
	"铺垫太长": ["slow_pacing"],
	"没耐心看": ["slow_pacing"],
	"信息密度": ["info_density_imbalance"],
	"太空洞": ["info_density_imbalance"],
	"太密集": ["info_density_imbalance"],

	// 社会议题
	"性别": ["gender_expression"],
	"男权": ["gender_expression"],
	"女权": ["gender_expression"],
	"刻板印象": ["gender_expression"],
	"阶层": ["class_expression"],
	"优越感": ["class_expression"],
	"精英": ["class_expression"],
	"身份政治": ["identity_politics"],
	"群体标签": ["identity_politics"],
	"对立": ["identity_politics"],
	"企业责任": ["corporate_responsibility"],
	"ESG": ["corporate_responsibility"],
	"环保": ["corporate_responsibility"],
	"劳工": ["corporate_responsibility"],
	"CSR": ["corporate_responsibility"],

	// 真实性
	"真实性": ["authenticity_check"],
	"编故事": ["authenticity_check"],
	"假经历": ["authenticity_check"],
	"造谣": ["authenticity_check"],
	"数据可信": ["data_credibility"],
	"数据来源": ["data_credibility"],
	"统计造假": ["data_credibility"],
	"过度包装": ["overhyped"],
	"吹牛": ["overhyped"],
	"夸大": ["overhyped"],
	"虚假宣传": ["overhyped"],
};

/** Region keyword → RegionalPackId mapping */
const REGION_KEYWORDS: Record<string, RegionalPackId[]> = {
	"中国": ["china"],
	"国内": ["china"],
	"大陆": ["china"],
	"中文": ["china"],
	"大陆语境": ["china"],
	"北美": ["north_america"],
	"美国": ["north_america"],
	"加拿大": ["north_america"],
	"英文": ["north_america"],
	"日本": ["japan"],
	"日语": ["japan"],
	"韩国": ["korea"],
	"韩语": ["korea"],
	"东南亚": ["southeast_asia"],
	"新加坡": ["southeast_asia"],
	"马来西亚": ["southeast_asia"],
	"泰国": ["southeast_asia"],
	"越南": ["southeast_asia"],
};

/** Platform keyword → PlatformCultureId mapping */
const PLATFORM_KEYWORDS: Record<string, PlatformCultureId[]> = {
	"HN": ["hacker_news"],
	"Hacker News": ["hacker_news"],
	"hacker news": ["hacker_news"],
	"Reddit": ["reddit"],
	"reddit": ["reddit"],
	"Twitter": ["twitter"],
	"twitter": ["twitter"],
	"X": ["twitter"],
	"推特": ["twitter"],
	"V2EX": ["v2ex"],
	"v2ex": ["v2ex"],
	"小红书": ["xiaohongshu"],
	"red": ["xiaohongshu"],
	"知乎": ["zhihu"],
	"zhihu": ["zhihu"],
	"抖音": ["douyin"],
	"douyin": ["douyin"],
	"微博": ["weibo"],
	"weibo": ["weibo"],
	"B站": ["bilibili"],
	"bilibili": ["bilibili"],
	"b站": ["bilibili"],
	"公众号": ["wechat_official"],
	"微信公众号": ["wechat_official"],
	"wechat": ["wechat_official"],
	"Instagram": ["instagram"],
	"instagram": ["instagram"],
	"ins": ["instagram"],
	"YouTube": ["youtube"],
	"youtube": ["youtube"],
	"油管": ["youtube"],
};

// ── Parsing Functions ──────────────────────────────────────────────────────

/**
 * Find all matching archetype IDs from a description string.
 */
function findArchetypes(description: string): ArchetypeId[] {
	const found = new Set<ArchetypeId>();
	const lowerDesc = description.toLowerCase();

	for (const [keyword, ids] of Object.entries(ARCHETYPE_KEYWORDS)) {
		if (lowerDesc.includes(keyword.toLowerCase())) {
			for (const id of ids) found.add(id);
		}
	}

	return Array.from(found);
}

/**
 * Find all matching trigger IDs from a description string.
 */
function findTriggers(description: string): TriggerId[] {
	const found = new Set<TriggerId>();
	const lowerDesc = description.toLowerCase();

	for (const [keyword, ids] of Object.entries(TRIGGER_KEYWORDS)) {
		if (lowerDesc.includes(keyword.toLowerCase())) {
			for (const id of ids) found.add(id);
		}
	}

	return Array.from(found);
}

/**
 * Find the best matching regional pack from a description string.
 * Returns the first match (in priority order: specific → general).
 */
function findRegionalPack(description: string): RegionalPackId | undefined {
	const lowerDesc = description.toLowerCase();

	// Check specific matches first
	for (const [keyword, ids] of Object.entries(REGION_KEYWORDS)) {
		if (lowerDesc.includes(keyword.toLowerCase())) {
			return ids[0];
		}
	}

	return undefined;
}

/**
 * Find the best matching platform culture from a description string.
 * Returns the first match.
 */
function findPlatformCulture(description: string): PlatformCultureId | undefined {
	// Check longer keywords first (e.g., "Hacker News" before "HN")
	const sortedKeywords = Object.keys(PLATFORM_KEYWORDS).sort((a, b) => b.length - a.length);

	for (const keyword of sortedKeywords) {
		if (description.includes(keyword)) {
			return PLATFORM_KEYWORDS[keyword][0];
		}
	}

	return undefined;
}

/**
 * Get sensible default triggers for an archetype if no triggers are found.
 */
function getDefaultTriggersForArchetype(archetype: ArchetypeId): TriggerId[] {
	const defaults: Record<ArchetypeId, TriggerId[]> = {
		pragmatic_consumer: ["overhyped", "clickbait"],
		technical_reviewer: ["jargon_density", "ai_writing", "overhyped"],
		low_attention_reader: ["slow_pacing", "info_density_imbalance"],
		anti_marketing_detector: ["ai_writing", "overhyped", "preachy_tone"],
		emotional_reactor: ["preachy_tone", "pretentious", "gender_expression"],
		logic_hunter: ["data_credibility", "authenticity_check", "slow_pacing"],
		social_value_observer: ["gender_expression", "class_expression", "identity_politics"],
		subculture_gatekeeper: ["jargon_density", "pretentious", "ai_writing"],
	};

	return defaults[archetype] || [];
}

// ── Main Parser ────────────────────────────────────────────────────────────

export interface ParseResult {
	config: RSTConfig;
	/** Human-readable summary of what was parsed */
	parsedDescription: string;
	/** Which layers were auto-detected vs explicitly found */
	confidence: {
		archetype: "explicit" | "inferred" | "default";
		triggers: "explicit" | "inferred" | "default";
		region: "explicit" | "inferred" | "default";
		platform: "explicit" | "inferred" | "default";
	};
}

/**
 * Parse a natural language description into an RSTConfig.
 *
 * @example
 * ```ts
 * parseNaturalLanguageRST("我想要一个对AI味很敏感的知乎用户")
 * // Returns: { config: { archetypes: [...], triggers: [...], regionalPack: "china", platformCulture: "zhihu" }, ... }
 *
 * parseNaturalLanguageRST("an anti-marketing HN reviewer who hates buzzwords")
 * // Returns: { config: { archetypes: ["anti_marketing_detector"], triggers: [...], regionalPack: "north_america", platformCulture: "hacker_news" }, ... }
 * ```
 */
export function parseNaturalLanguageRST(description: string): ParseResult {
	const archetypes = findArchetypes(description);
	const triggers = findTriggers(description);
	const region = findRegionalPack(description);
	const platform = findPlatformCulture(description);

	// Determine confidence levels
	const archetypeConfidence: "explicit" | "inferred" | "default" =
		archetypes.length > 0 ? "explicit" : "default";
	const triggersConfidence: "explicit" | "inferred" | "default" =
		triggers.length > 0 ? "explicit" : "default";
	const regionConfidence: "explicit" | "inferred" | "default" =
		region ? "explicit" : "default";
	const platformConfidence: "explicit" | "inferred" | "default" =
		platform ? "explicit" : "default";

	// Fallback to most common archetype if none found
	const finalArchetypes: ArchetypeId[] = archetypes.length > 0
		? archetypes.slice(0, 2) // Max 2 archetypes
		: ["anti_marketing_detector"]; // Default to anti-marketing (most common use case)

	// Fallback triggers based on archetype
	const finalTriggers: TriggerId[] = triggers.length > 0
		? triggers
		: getDefaultTriggersForArchetype(finalArchetypes[0]);

	// Default region and platform
	const finalRegion: RegionalPackId = region || "china";
	finalRegion; // ensure used
	const finalPlatform: PlatformCultureId = platform || "zhihu";
	finalPlatform; // ensure used

	// Build summary
	const archetypeLabels = finalArchetypes.map(id => RST_ARCHETYPES[id]?.label || id);
	const triggerLabels = finalTriggers.map(id => RST_TRIGGERS[id]?.label || id);
	const regionLabel = RST_REGIONAL_PACKS[finalRegion]?.label || finalRegion;
	const platformLabel = RST_PLATFORM_CULTURES[finalPlatform]?.label || finalPlatform;

	const parsedDescription = [
		`人格：${archetypeLabels.join(" + ")}`,
		`敏感触发器：${triggerLabels.join("、")}`,
		`文化语境：${regionLabel}`,
		`活跃平台：${platformLabel}`,
	].join("；");

	return {
		config: {
			archetypes: finalArchetypes,
			triggers: finalTriggers,
			regionalPack: finalRegion,
			platformCulture: finalPlatform,
		},
		parsedDescription,
		confidence: {
			archetype: archetypeConfidence,
			triggers: triggersConfidence,
			region: regionConfidence,
			platform: platformConfidence,
		},
	};
}

/**
 * Check if a user input looks like it should be parsed as natural language RST
 * (as opposed to a numeric selection or preset name).
 *
 * Returns true if the input:
 * - Is not a simple number
 * - Contains RST-related keywords (archetype, trigger, region, platform)
 * - Is long enough to be a natural language description
 */
export function isNaturalLanguageRSTInput(input: string): boolean {
	const trimmed = input.trim();

	// Reject simple numbers
	if (/^\d+$/.test(trimmed)) return false;

	// Reject very short inputs
	if (trimmed.length < 3) return false;

	// Check for RST-related keywords
	const hasArchetypeKeyword = Object.keys(ARCHETYPE_KEYWORDS).some(k =>
		trimmed.toLowerCase().includes(k.toLowerCase())
	);
	const hasTriggerKeyword = Object.keys(TRIGGER_KEYWORDS).some(k =>
		trimmed.toLowerCase().includes(k.toLowerCase())
	);
	const hasRegionKeyword = Object.keys(REGION_KEYWORDS).some(k =>
		trimmed.toLowerCase().includes(k.toLowerCase())
	);
	const hasPlatformKeyword = Object.keys(PLATFORM_KEYWORDS).some(k =>
		trimmed.includes(k)
	);

	// If any RST keyword is found, treat as natural language
	if (hasArchetypeKeyword || hasTriggerKeyword || hasRegionKeyword || hasPlatformKeyword) {
		return true;
	}

	// If it's a longer text without obvious preset names, treat as natural language
	if (trimmed.length > 10) {
		return true;
	}

	return false;
}
