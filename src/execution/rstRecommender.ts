/**
 * RST Persona Recommender
 *
 * Recommends the best-matching RST-configured personas for a given content
 * based on pre-audit findings, trigger coverage, archetype focus, and platform match.
 *
 * This is a pure function module — no MCP sampling dependency.
 */

import type { Persona } from "../utils/parser.js";
import type { RSTConfig, TriggerId, ArchetypeId, OffensiveDimensionId } from "./dimensions.js";
import { RST_TRIGGERS, RST_ARCHETYPES, RST_PLATFORM_CULTURES, ALL_TRIGGER_IDS } from "./dimensions.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface Recommendation {
	/** Ordered list of recommended persona IDs (1-3) */
	personaIds: string[];
	/** Human-readable recommendation message */
	assistantMessage: string;
}

interface PersonaScore {
	persona: Persona;
	score: number;
	reasons: string[];
}

interface PreAuditFinding {
	auditorId: string;
	keyword?: string;
	trigger?: string;
	riskDescription?: string;
	dimension?: string;
	suggestedLevel?: string;
}

interface PreAuditDimension {
	id: string;
	name?: string;
	findings?: PreAuditFinding[];
}

interface PreAuditReport {
	dimensions?: PreAuditDimension[];
}

// ── Core Recommendation Function ───────────────────────────────────────────

/**
 * Recommend the best-matching RST personas based on content and pre-audit results.
 *
 * Scoring algorithm:
 *   - Trigger coverage: +3 per finding that matches persona's triggers
 *   - Archetype focus: +2 per high-risk dimension covered by archetype's focus
 *   - Platform match: +1 if persona's platform matches target platform
 *
 * @param content - The content being reviewed (used for keyword matching)
 * @param preAuditReport - Pre-audit findings report
 * @param availablePersonas - All available personas to choose from
 * @param targetPlatform - Optional target publishing platform for matching
 * @returns Recommendation with top 1-3 persona IDs and reasoning
 */
export function recommendRSTPersonas(
	content: string,
	preAuditReport: PreAuditReport | undefined,
	availablePersonas: Persona[],
	targetPlatform?: string,
): Recommendation {
	if (availablePersonas.length === 0) {
		return { personaIds: [], assistantMessage: "没有可用的评审员。" };
	}

	// Separate RST and non-RST personas
	const rstPersonas = availablePersonas.filter(p => p.meta.rst);
	const nonRstPersonas = availablePersonas.filter(p => !p.meta.rst);

	// If no RST personas, return empty (caller should use fallback)
	if (rstPersonas.length === 0) {
		return { personaIds: [], assistantMessage: "" };
	}

	// Extract findings from pre-audit report
	const findings = extractFindings(preAuditReport);

	// Identify high-risk dimensions (dimensions with 🟡 or 🔴 findings)
	const highRiskDimensions = findHighRiskDimensions(findings);

	// Score each RST persona
	const scored: PersonaScore[] = rstPersonas.map(persona => {
		const rst = persona.meta.rst!;
		const reasons: string[] = [];
		let score = 0;

		// 1. Trigger coverage: +3 per matching finding
		const triggerMatches = countTriggerMatches(findings, rst.triggers);
		score += triggerMatches * 3;
		if (triggerMatches > 0) {
			const matchedTriggerLabels = getMatchedTriggerLabels(findings, rst.triggers);
			reasons.push(`触发器匹配 ${triggerMatches} 项（${matchedTriggerLabels.join("、")}）`);
		}

		// 2. Archetype focus: +2 per high-risk dimension covered by focus dimensions
		const focusDims = getArchetypeFocusDimensions(rst.archetypes);
		const focusOverlap = highRiskDimensions.filter(d => focusDims.includes(d));
		score += focusOverlap.length * 2;
		if (focusOverlap.length > 0) {
			const dimLabels = focusOverlap.map(d => getDimensionLabel(d));
			reasons.push(`人格焦点覆盖高风险维度：${dimLabels.join("、")}`);
		}

		// 3. Platform match: +1 if platform matches target
		if (targetPlatform && rst.platformCulture) {
			const platformMatch = checkPlatformMatch(rst.platformCulture, targetPlatform);
			if (platformMatch) {
				score += 1;
				reasons.push(`平台匹配：${RST_PLATFORM_CULTURES[rst.platformCulture]?.label || rst.platformCulture}`);
			}
		}

		return { persona, score, reasons };
	});

	// Sort by score descending, then by number of reasons (tiebreak)
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return b.reasons.length - a.reasons.length;
	});

	// Take top 1-3 (but never more than available)
	const maxRecommend = Math.min(3, rstPersonas.length);
	const topScored = scored.slice(0, maxRecommend);

	// If top score is 0, still recommend at least 1 (the highest-scoring one)
	if (topScored.length === 0 || topScored[0].score === 0) {
		// Fallback: recommend first persona with generic reason
		return {
			personaIds: [scored[0].persona.meta.id],
			assistantMessage: buildRecommendationMessage([{
				...scored[0],
				reasons: ["当前可用的 RST 评审员中，此评审员的人格配置最接近目标"],
			}]),
		};
	}

	return {
		personaIds: topScored.map(s => s.persona.meta.id),
		assistantMessage: buildRecommendationMessage(topScored),
	};
}

// ── Helper Functions ───────────────────────────────────────────────────────

/**
 * Extract all findings from pre-audit report into a flat array.
 */
function extractFindings(report: PreAuditReport | undefined): PreAuditFinding[] {
	if (!report?.dimensions) return [];

	const findings: PreAuditFinding[] = [];
	for (const dim of report.dimensions) {
		if (!dim.findings) continue;
		for (const finding of dim.findings) {
			findings.push({
				...finding,
				auditorId: dim.id,
			});
		}
	}
	return findings;
}

/**
 * Find dimensions that have 🟡 or 🔴 findings.
 */
function findHighRiskDimensions(findings: PreAuditFinding[]): OffensiveDimensionId[] {
	const riskDims = new Set<OffensiveDimensionId>();

	for (const finding of findings) {
		if (finding.suggestedLevel !== "🟡" && finding.suggestedLevel !== "🔴") continue;

		// Map auditor IDs to offensive dimensions they relate to
		const mappedDims = mapAuditorToDimensions(finding.auditorId);
		for (const d of mappedDims) riskDims.add(d);
	}

	return Array.from(riskDims);
}

/**
 * Map an auditor ID to the offensive dimensions it typically relates to.
 */
function mapAuditorToDimensions(auditorId: string): OffensiveDimensionId[] {
	const mapping: Record<string, OffensiveDimensionId[]> = {
		legal_compliance: ["action_conversion", "differentiation"],
		context_distortion: ["hook_retention", "narrative_structure"],
		network_culture_risk: ["differentiation", "virality_potential"],
		factual_integrity: ["information_gap", "narrative_structure"],
		social_risk: ["emotional_resonance", "virality_potential"],
	};
	return mapping[auditorId] || [];
}

/**
 * Count how many findings match any of the persona's triggers.
 */
function countTriggerMatches(findings: PreAuditFinding[], triggers: TriggerId[]): number {
	let count = 0;
	for (const finding of findings) {
		if (findingMatchesAnyTrigger(finding, triggers)) {
			count++;
		}
	}
	return count;
}

/**
 * Get labels of triggers that matched findings.
 */
function getMatchedTriggerLabels(findings: PreAuditFinding[], triggers: TriggerId[]): string[] {
	const matched = new Set<TriggerId>();
	for (const finding of findings) {
		for (const triggerId of triggers) {
			if (triggerMatchesFinding(finding, triggerId)) {
				matched.add(triggerId);
			}
		}
	}
	return Array.from(matched).map(id => RST_TRIGGERS[id]?.label || id);
}

/**
 * Check if a finding matches any of the given triggers.
 */
function findingMatchesAnyTrigger(finding: PreAuditFinding, triggers: TriggerId[]): boolean {
	for (const triggerId of triggers) {
		if (triggerMatchesFinding(finding, triggerId)) return true;
	}
	return false;
}

/**
 * Check if a finding matches a specific trigger.
 * Uses the trigger's retainedAuditors and retainedPatterns.
 */
function triggerMatchesFinding(finding: PreAuditFinding, triggerId: TriggerId): boolean {
	const triggerDef = RST_TRIGGERS[triggerId];
	if (!triggerDef) return false;

	// Check if the trigger is interested in findings from this auditor
	if (!triggerDef.retainedAuditors.includes(finding.auditorId)) return false;

	// Check if any retained pattern matches the finding content
	if (triggerDef.retainedPatterns?.length) {
		const findingText = `${finding.keyword || ""} ${finding.trigger || ""} ${finding.riskDescription || ""} ${finding.dimension || ""}`.toLowerCase();
		const hasMatch = triggerDef.retainedPatterns.some(p => findingText.includes(p));
		if (!hasMatch) return false;
	}

	return true;
}

/**
 * Get the focus dimensions for a set of archetypes (union).
 */
function getArchetypeFocusDimensions(archetypes: ArchetypeId[]): OffensiveDimensionId[] {
	const dims = new Set<OffensiveDimensionId>();
	for (const archId of archetypes) {
		const arch = RST_ARCHETYPES[archId];
		if (!arch) continue;
		for (const d of arch.focusDimensions) dims.add(d);
	}
	return Array.from(dims);
}

/**
 * Check if a persona's platform matches the target platform.
 */
function checkPlatformMatch(personaPlatform: string, targetPlatform: string): boolean {
	const target = targetPlatform.toLowerCase();
	const persona = personaPlatform.toLowerCase();

	// Direct match
	if (persona === target) return true;

	// Alias matching
	const aliases: Record<string, string[]> = {
		hacker_news: ["hn", "hacker news"],
		reddit: ["reddit"],
		twitter: ["twitter", "x", "推特"],
		v2ex: ["v2ex"],
		xiaohongshu: ["小红书", "xhs", "red"],
		zhihu: ["知乎"],
		douyin: ["抖音"],
		weibo: ["微博"],
		bilibili: ["b站", "bilibili"],
		wechat_official: ["公众号", "微信公众号", "wechat"],
		instagram: ["instagram", "ins"],
		youtube: ["youtube", "油管"],
	};

	const platformAliases = aliases[personaPlatform] || [];
	return platformAliases.some(alias => target.includes(alias));
}

/**
 * Get a human-readable label for an offensive dimension ID.
 */
function getDimensionLabel(dim: OffensiveDimensionId): string {
	const labels: Record<OffensiveDimensionId, string> = {
		hook_retention: "开篇钩子",
		virality_potential: "传播力",
		narrative_structure: "叙事结构",
		emotional_resonance: "情感共鸣",
		action_conversion: "行动转化",
		differentiation: "差异化",
		information_gap: "信息差",
	};
	return labels[dim] || dim;
}

/**
 * Build the recommendation message from scored personas.
 */
function buildRecommendationMessage(scored: PersonaScore[]): string {
	const lines = [
		"根据内容特色和初审发现的风险点，为您推荐了以下评审员：",
		"",
	];

	for (const { persona, reasons } of scored) {
		const rst = persona.meta.rst;
		const archLabel = rst
			? rst.archetypes.map(id => RST_ARCHETYPES[id]?.label || id).join("+")
			: "无 RST";

		lines.push(`- **${persona.meta.name}**（${archLabel}）`);
		if (reasons.length > 0) {
			lines.push(`  推荐理由：${reasons.join("；")}`);
		}
		lines.push("");
	}

	lines.push("请向用户展示以上推荐结果，等待用户选择。");
	return lines.join("\n");
}
