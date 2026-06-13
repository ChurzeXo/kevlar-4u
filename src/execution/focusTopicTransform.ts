/**
 * Focus Topic Transformer
 *
 * Transforms raw pre-audit findings into guided Focus Topics
 * for RST-configured reviewers. Three-step pipeline:
 *   1. Filter — retain findings that match the reviewer's L2 Triggers
 *   2. Translate — convert audit language → natural prompt language
 *   3. Persona Adapt — adjust tone based on L1 Archetype + tone
 */

import type { RSTConfig, TriggerId } from "./dimensions.js";
import { RST_TRIGGERS, RST_ARCHETYPES } from "./dimensions.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface FocusTopic {
	/** Original auditor finding */
	sourceAuditor: string;
	sourceKeyword: string;
	/** Matched trigger ID that caused this to be retained */
	matchedTrigger: TriggerId;
	/** Translated natural-language prompt for the reviewer */
	prompt: string;
}

// ── Translation Templates ──────────────────────────────────────────────────
// Maps (auditor ID + trigger category) → template function
// The template receives the finding's keyword and risk description,
// and returns a natural-language Focus Topic prompt.

type TranslationFn = (keyword: string, riskDescription: string) => string;
type MatrixTranslationFn = (paragraph: string, finding: any) => string;

const AUDITOR_ID_ALIASES: Record<string, string> = {
	social_risk_ethics: "social_risk",
};

const SYSTEM_AUDITOR_LABELS: Record<string, string> = {
	social_risk: "社会风险与群体伦理",
	legal_compliance: "合规与法律红线",
	context_distortion: "语境脱嵌与恶意曲解",
	factual_integrity: "事实硬伤与常识背离",
	network_culture_risk: "网络文化风险",
	cross_lingual_distortion: "跨语言曲解与恶意机翻",
};

const MATRIX_TRANSLATION_MAP: Record<string, MatrixTranslationFn> = {
	social_risk: (paragraph) =>
		`该文本在初审中被检测出在第 ${paragraph} 段可能存在“因谐音、擦边表达或群体措辞引发特定群体反感”的隐患。请根据你的立场，严厉审视该段落是否让你感到被冒犯或不适。`,
	legal_compliance: (paragraph) =>
		`该文本在初审中被检测出在第 ${paragraph} 段存在“过度包装、吹嘘功能”的嫌疑。请以你刻薄、理性的视角，死磕该段落是否在“画饼”或缺乏事实依据。`,
	context_distortion: (paragraph) =>
		`该文本在第 ${paragraph} 段的表达极易被脱离上下文单独截图。请模拟恶意网友的放大镜思维，测试能否将该段话歪曲为“精英阶层的傲慢说教”。`,
	factual_integrity: (paragraph) =>
		`该文本在第 ${paragraph} 段的推论存在逻辑漏洞。请发挥你找茬的本能，把这个逻辑死角揪出来，并用最直接的语言进行尖锐吐槽。`,
	network_culture_risk: (paragraph) =>
		`该文本在第 ${paragraph} 段疑似使用了未脱敏的网络黑话或烂梗。请站在你的圈层视角，审查作者是否在「盲目蹭热度」，并给出你的排斥性评论。`,
	cross_lingual_distortion: (paragraph) =>
		`该文本在第 ${paragraph} 段包含外文表达，初审检测出存在被恶意汉化或野生翻译的风险。请以最挑剔的网民视角，审查这些外文是否容易被曲解成低俗梗或引发群嘲。`,
};

const TRANSLATION_MAP: Record<string, TranslationFn> = {
	// legal_compliance + overhyped
	"legal_compliance:overhyped": (kw, _rd) =>
		`这篇文案在表达上有明显的营销包装痕迹，尤其是「${kw}」这类用语，你注意到了吗？`,

	// social_risk + preachy_tone
	"social_risk:preachy_tone": (kw, _rd) =>
		`内容中「${kw}」这类表述给人一种居高临下的感觉，你可能会对此比较敏感。`,

	// social_risk + pretentious
	"social_risk:pretentious": (kw, _rd) =>
		`「${kw}」这种表达有故作深刻的嫌疑，按你的审美标准可能不太买账。`,

	// social_risk + gender_expression
	"social_risk:gender_expression": (kw, _rd) =>
		`内容中涉及性别相关的表达「${kw}」，可能存在刻板印象风险。`,

	// social_risk + class_expression
	"social_risk:class_expression": (kw, _rd) =>
		`「${kw}」这种表述隐含阶层优越感，可能引发部分读者反感。`,

	// social_risk + identity_politics
	"social_risk:identity_politics": (kw, _rd) =>
		`内容中「${kw}」涉及群体标签化表达，存在身份政治敏感性。`,

	// social_risk + corporate_responsibility
	"social_risk:corporate_responsibility": (kw, _rd) =>
		`「${kw}」涉及企业责任相关话题，可能触发相关议题的敏感度。`,

	// context_distortion + clickbait
	"context_distortion:clickbait": (kw, _rd) =>
		`初审发现标题或某些表述存在与正文偏差的风险，尤其是「${kw}」。`,

	// context_distortion + ai_writing
	"context_distortion:ai_writing": (kw, _rd) =>
		`「${kw}」这类表达有模板化痕迹，可能被识别为套路化写作。`,

	// network_culture_risk + jargon_density
	"network_culture_risk:jargon_density": (kw, _rd) =>
		`内容中使用了较多行业术语或网络黑话「${kw}」，可能影响可读性。`,

	// network_culture_risk + ai_writing
	"network_culture_risk:ai_writing": (kw, _rd) =>
		`「${kw}」这类表达带有明显的 AI 写作或模板化特征。`,

	// network_culture_risk + identity_politics
	"network_culture_risk:identity_politics": (kw, _rd) =>
		`内容中「${kw}」在网络社区语境下可能被放大解读。`,

	// factual_integrity + authenticity_check
	"factual_integrity:authenticity_check": (kw, _rd) =>
		`内容中「${kw}」的真实性存疑，可能是编造或夸大的经历。`,

	// factual_integrity + data_credibility
	"factual_integrity:data_credibility": (kw, _rd) =>
		`「${kw}」引用的数据缺乏明确来源，可信度需要打个问号。`,

	// factual_integrity + slow_pacing
	"factual_integrity:slow_pacing": (kw, _rd) =>
		`内容中存在信息冗余或节奏拖沓的段落，读者可能会失去耐心。`,

	// factual_integrity + info_density_imbalance
	"factual_integrity:info_density_imbalance": (kw, _rd) =>
		`「${kw}」所在段落的信息密度存在问题，要么太空洞要么太密集。`,

	// cross_lingual_distortion + jargon_density
	"cross_lingual_distortion:jargon_density": (kw, _rd) =>
		`文案中出现了外文词「${kw}」，容易被网友抓住进行恶意汉化或谐音曲解。`,

	// cross_lingual_distortion + pretentious
	"cross_lingual_distortion:pretentious": (kw, _rd) =>
		`文案中夹杂外文「${kw}」有「故意装高级」之嫌，可能引发反感。`,

	// cross_lingual_distortion + identity_politics
	"cross_lingual_distortion:identity_politics": (kw, _rd) =>
		`外文表达「${kw}」在国内舆论场可能存在文化水土不服，需要警惕被贴上标签。`,
};

// Fallback template when no specific mapping exists
function fallbackTemplate(auditorName: string, keyword: string): string {
	return `初审在【${auditorName}】维度发现了「${keyword}」相关问题，请你根据自己的视角判断这是否值得关注。`;
}

// ── Core Transform Pipeline ────────────────────────────────────────────────

/**
 * Transform raw pre-audit findings into Focus Topics for a specific reviewer.
 *
 * @param preAuditReport - Raw findings from system auditors
 * @param rst - The reviewer's RST configuration
 * @returns Array of Focus Topics to inject into the review prompt
 */
export function transformFindingsToFocusTopics(
	preAuditReport: any,
	rst: RSTConfig
): FocusTopic[] {
	if (!preAuditReport?.dimensions?.length) return [];

	const activeTriggers = new Set(rst.triggers);
	const focusTopics: FocusTopic[] = [];

	for (const dimension of preAuditReport.dimensions) {
		if (!dimension.findings?.length) continue;

		const auditorId = normalizeAuditorId(dimension.id || dimension.auditorId || "");
		const auditorName = dimension.name || auditorId;

		for (let index = 0; index < dimension.findings.length; index++) {
			const finding = dimension.findings[index];
			// Step 1: Filter — check if any of the reviewer's triggers match this finding
			const matchedTrigger = findMatchingTrigger(auditorId, finding, activeTriggers);
			if (!matchedTrigger) continue;

			// Step 2: Translate — convert to natural language
			const prompt = translateFinding(auditorId, auditorName, finding, index, matchedTrigger);

			// Step 3: Persona Adapt — adjust tone based on archetype
			const adaptedPrompt = adaptToneToArchetype(prompt, rst);

			focusTopics.push({
				sourceAuditor: auditorName,
				sourceKeyword: finding.keyword || finding.dimension || "",
				matchedTrigger,
				prompt: adaptedPrompt,
			});
		}
	}

	return focusTopics;
}

/**
 * Find which of the reviewer's active triggers matches a given finding.
 * Returns the first matching TriggerId, or undefined if none match.
 */
function findMatchingTrigger(
	auditorId: string,
	finding: any,
	activeTriggers: Set<TriggerId>
): TriggerId | undefined {
	for (const triggerId of activeTriggers) {
		const triggerDef = RST_TRIGGERS[triggerId];
		if (!triggerDef) continue;

		// Check if this trigger is interested in findings from this auditor
		if (!triggerDef.retainedAuditors.includes(auditorId)) continue;

		// Check if any retained pattern matches the finding content
		if (triggerDef.retainedPatterns?.length) {
			const findingText = `${finding.keyword || ""} ${finding.trigger || ""} ${finding.riskDescription || ""} ${finding.description || ""}`.toLowerCase();
			const hasMatch = triggerDef.retainedPatterns.some(p => findingText.includes(p));
			if (!hasMatch) continue;
		}

		return triggerId;
	}
	return undefined;
}

function normalizeAuditorId(auditorId: string): string {
	return AUDITOR_ID_ALIASES[auditorId] || auditorId;
}

function translateFinding(
	auditorId: string,
	auditorName: string,
	finding: any,
	findingIndex: number,
	matchedTrigger: TriggerId,
): string {
	const paragraph = resolveParagraphLabel(finding, findingIndex);
	const matrixTemplate = MATRIX_TRANSLATION_MAP[auditorId];
	if (matrixTemplate) {
		return matrixTemplate(paragraph, finding);
	}

	const templateKey = `${auditorId}:${matchedTrigger}`;
	const template = TRANSLATION_MAP[templateKey];
	if (template) {
		return template(finding.keyword || finding.dimension || "", finding.riskDescription || finding.description || "");
	}

	return fallbackTemplate(SYSTEM_AUDITOR_LABELS[auditorId] || auditorName, finding.keyword || finding.dimension || "");
}

function resolveParagraphLabel(finding: any, findingIndex: number): string {
	const candidates = [
		finding.paragraph,
		finding.paragraphNo,
		finding.paragraphNumber,
		finding.paragraphIndex,
		finding.section,
	];

	for (const candidate of candidates) {
		if (candidate === undefined || candidate === null || candidate === "") continue;
		const numeric = Number(candidate);
		if (Number.isFinite(numeric)) {
			const value = String(Math.max(1, Math.trunc(numeric)));
			return value;
		}
		return String(candidate);
	}

	return String(findingIndex + 1);
}

/**
 * Adjust Focus Topic prompt tone based on the reviewer's L1 Archetype.
 * Makes the prompt feel more natural for the persona.
 */
function adaptToneToArchetype(prompt: string, rst: RSTConfig): string {
	if (!rst.archetypes.length) return prompt;

	const primaryArchetype = rst.archetypes[0];
	const archetype = RST_ARCHETYPES[primaryArchetype];
	if (!archetype) return prompt;

	// Add a soft framing that matches the archetype's perspective
	const frames: Record<string, string> = {
		pragmatic_consumer: "从实用角度看，",
		technical_reviewer: "从技术角度看，",
		low_attention_reader: "快速扫一眼，",
		anti_marketing_detector: "从营销嗅觉看，",
		emotional_reactor: "凭直觉感受，",
		logic_hunter: "从逻辑角度看，",
		social_value_observer: "从社会价值角度看，",
		subculture_gatekeeper: "从圈内人角度看，",
	};

	const frame = frames[primaryArchetype];
	return frame ? `${frame}${prompt}` : prompt;
}

/**
 * Format Focus Topics into a prompt section for injection.
 */
export function formatFocusTopicsForPrompt(topics: FocusTopic[]): string {
	if (!topics.length) return "";

	const lines = [
		"# 🎯 狙击手定点复审焦点（核心火力集中点）",
		"",
		"系统在文本雷达扫描中发现了以下可疑点，请你作为狙击手，执行定向抗压测试：",
		"",
	];

	for (let i = 0; i < topics.length; i++) {
		lines.push(`> 旁白提示 ${i + 1}：${topics[i].prompt}`);
	}

	lines.push("");
	lines.push("# 专项执行指令");
	lines.push("请你重点审视上述【旁白提示】中提及的段落。如果它触动了你的神经，请不要客气，直接一针见血地指出创作者的“装腔作势”或“盲点”，并给出你最真实的吐槽。");

	return lines.join("\n");
}
