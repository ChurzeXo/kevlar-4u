/**
 * Review Dimensions Configuration
 *
 * Defines the two-layer dimension system:
 *   - Defensive (mandatory, always active)
 *   - Offensive (user-selectable, defaults to all)
 */

// ── Dimension Types ──────────────────────────────────────────────────────────

export type DimensionLayer = "defensive" | "offensive";

export type DefensiveDimensionId =
	| "social_risk_ethics"
	| "legal_compliance"
	| "context_distortion"
	| "factual_integrity"
	| "network_culture_risk";

export type OffensiveDimensionId =
	| "hook_retention"
	| "virality_potential"
	| "narrative_structure"
	| "emotional_resonance"
	| "action_conversion"
	| "differentiation"
	| "information_gap";

export type DimensionId = DefensiveDimensionId | OffensiveDimensionId;

export interface DimensionDefinition {
	id: DimensionId;
	layer: DimensionLayer;
	label: string;
	description: string;
	sentinelPoints: string[];
	/** Conditional sentinels that activate only when content matches certain topics */
	conditionalSentinels?: { trigger: string; description: string }[];
	criteria: {
		green: string;
		yellow: string;
		red: string;
	};
}

export interface DimensionsConfig {
	/** @deprecated Defensive dimensions are now mandatory system directives, not configurable. Kept for backward compat. */
	defensive?: DefensiveDimensionId[];
	offensive: OffensiveDimensionId[];
}

// ── All Dimension Definitions ────────────────────────────────────────────────

export const DIMENSIONS: Record<DimensionId, DimensionDefinition> = {
	// ── Defensive (mandatory) ──────────────────────────────────────────────

	social_risk_ethics: {
		id: "social_risk_ethics",
		layer: "defensive",
		label: "社会风险与群体伦理",
		description: "审查内容是否触及群体对立、公序良俗或无意低俗联想",
		sentinelPoints: [
			"性别/地域/阶层/职业歧视",
			"物化与低俗擦边",
			"隐性特权凝视",
			"词汇多义/谐音/联想导致的低俗化风险（含身体器官联想、性暗示联想、方言俗语联想）",
		],
		conditionalSentinels: [
			{
				trigger: "跨文化/亚文化/民族/宗教元素",
				description: "文化挪用与次生文化误读——文化元素是否被简化为装饰符号、脱离原生语境使用或被歪曲猎奇化",
			},
			{
				trigger: "食品/身体/感官类描述（尤其是颜色+形态+质地的组合）",
				description: "词汇身体联想风险——描述是否在字形、读音或语义上与性器官/身体敏感部位产生联想；粉+耳/朵/花/洞、白+嫩/滑/软、肥+厚/满/润等高敏感组合需逐词审查是否构成无意低俗化",
			},
		],
		criteria: {
			green: "内容未涉及任何群体敏感性话题，或涉及但处理方式尊重、平衡、无刻板印象；用词无低俗联想风险",
			yellow: "存在隐性风险——可能被部分群体解读为冒犯但无明确恶意；使用了有争议的比喻/类比但语境中可解释；隐性特权凝视存在但非主导叙事；用词存在可被联想为低俗的可能但需要刻意解读",
			red: "存在显性冒犯——包含物化、刻板印象、群体标签化、低俗擦边、阶层对立暗示；或隐性特权凝视构成内容核心逻辑；用词组合直接触发身体器官/性暗示联想，即使无主观恶意也构成低俗化风险",
		},
	},

	legal_compliance: {
		id: "legal_compliance",
		layer: "defensive",
		label: "合规与法律红线",
		description: "审查内容是否违反广告法、平台规则或意识形态红线",
		sentinelPoints: [
			"广告法违规（绝对化用语、虚假宣传）",
			"平台规则与限流关键词",
			"政治/历史红线",
			"伪科学伪功效描述",
		],
		criteria: {
			green: "内容符合广告法、平台规则，无绝对化用语，无敏感词触发风险",
			yellow: "存在模糊地带——使用了接近绝对化的表述但语境中可能不构成违法；功效描述有夸大倾向但未达伪科学程度；存在平台限流关键词但非故意规避",
			red: "违反广告法（绝对化用语、虚假宣传）；触碰政治/历史红线；涉嫌诱导/欺诈；伪科学伪功效描述明确；包含平台封禁级敏感词",
		},
	},

	context_distortion: {
		id: "context_distortion",
		layer: "defensive",
		label: "语境脱嵌与恶意曲解风险",
		description: "审查内容脱离语境后是否容易被恶意曲解",
		sentinelPoints: [
			"截图脱语境化风险",
			"标题党截断风险",
			"短视频二创曲解风险",
			"表情包化传播风险",
		],
		criteria: {
			green: "内容语境完整、自洽，即使被截图/截断也难以脱离原意；关键判断有充分的前置条件限定",
			yellow: "存在可被脱离语境的关键句——某句话脱离上下文后语义会发生偏移但完整阅读可还原意图；存在容易被标题党化截取的片段",
			red: "存在极易被恶意曲解的表达——某句话脱离语境后含义发生根本性反转；关键结论缺乏前置条件保护；内容天然适合被截图传播并引发误读",
		},
	},

	factual_integrity: {
		id: "factual_integrity",
		layer: "defensive",
		label: "事实硬伤与常识背离",
		description: "审查内容是否存在常识性错误、断章取义或逻辑硬伤",
		sentinelPoints: [
			"数据造假或严重失实",
			"常识性错误（违反物理/生理/法律常识）",
			"伪科普伪功效",
			"过时信息",
			"因果谬误",
		],
		criteria: {
			green: "事实论据可验证、数据有出处、因果推理逻辑成立；无非专业领域常识错误",
			yellow: "存在可修正的事实问题——数据未更新但非核心论点；个别用词不精确但可推断真实意图；因果推理存在跳跃但不构成逻辑硬伤",
			red: "存在根本性事实错误——数据造假或严重失实；常识性错误；伪科普伪功效；因果谬误构成内容核心论点的基础",
		},
	},

	network_culture_risk: {
		id: "network_culture_risk",
		layer: "defensive",
		label: "网络文化风险",
		description: "审查内容是否存在黑话撞车、圈层烂梗、粉圈冲突暗语或跨平台语境误读",
		sentinelPoints: [
			"黑话撞车与亚文化用语滥用",
			"谐音、缩写、数字暗语、Emoji 组合等隐晦表达",
			"粉圈冲突与圈层排斥性暗语",
			"跨平台语境差异导致的误读或嘲讽风险",
		],
		criteria: {
			green: "内容未使用高风险网络黑话或圈层暗语；表达在主流平台语境下清晰、稳定，不易被误读为蹭梗或冒犯",
			yellow: "存在网络流行语、圈层梗或缩写表达，可能被部分用户解读为跟风、蹭热度或语境不稳，但尚可通过改写脱敏",
			red: "明确命中特定圈层黑话、侮辱性谐音/缩写、粉圈冲突暗语或高风险烂梗，容易引发群体嘲讽、抵制或平台风险",
		},
	},

	// ── Offensive (user-selectable) ─────────────────────────────────────────

	hook_retention: {
		id: "hook_retention",
		layer: "offensive",
		label: "开篇钩子与首屏留存率",
		description: "审查内容开篇的吸睛程度和首屏信息密度",
		sentinelPoints: [
			"标题/首段的钩子锋利度",
			"首屏信息密度与冗余铺垫",
			"信息流中的视觉/语义区隔度",
		],
		criteria: {
			green: "开篇精准命中目标读者的痛点/好奇心/身份认同；首屏信息密度高且无冗余铺垫；在信息流中有明确的区隔度",
			yellow: "开篇有吸引力但不够锋利——需要1-2句铺垫才能进入核心；首屏有信息但缺乏让手指停下的钩子；在信息流中容易被划过",
			red: "开篇为泛化寒暄/自我介绍/背景铺垫；首屏无有效信息；在信息流中与同类内容无差异，缺乏停留理由",
		},
	},

	virality_potential: {
		id: "virality_potential",
		layer: "offensive",
		label: "传播力与裂变潜能",
		description: "审查内容是否具备让人产生转发/收藏/评论的社交驱动力",
		sentinelPoints: [
			"社交货币价值（转发后是否让人显得有品位/有远见/有信息优势）",
			"情绪驱动力（愤怒/感动/共鸣）",
			"自传播机制（金句/可截图段落/争议性观点）",
		],
		criteria: {
			green: "内容提供了高价值社交货币或触发了强烈情绪驱动力；有明确的自传播机制（金句/可截图段落/争议性观点）",
			yellow: "内容有价值但缺乏传播驱动力——有用但不足以让人主动分享；有情绪但不够强烈；缺少可被截取传播的金句锚点",
			red: "内容为纯自嗨/品牌独白；既无社交货币价值也无情绪驱动力；读者看完没有转发的心理动机",
		},
	},

	narrative_structure: {
		id: "narrative_structure",
		layer: "offensive",
		label: "叙事结构与信息密度",
		description: "审查内容的结构流畅度、逻辑连贯性与信息冗余度",
		sentinelPoints: [
			"逻辑链完整性与断裂检测",
			"段落衔接自然度",
			"信息冗余度（重复表述/填充内容）",
			"节奏控制（松紧交替）",
		],
		criteria: {
			green: "结构清晰，逻辑链完整无断裂；段落衔接自然，节奏有松有紧；信息密度高且无冗余填充；论证有层次递进",
			yellow: "整体结构可辨认但局部松散；存在冗余段落或重复表述；逻辑链有跳跃但可自行补全；节奏偏平，缺少起伏",
			red: "结构散乱，逻辑链断裂；大量填充性内容拉低信息密度；段落间无衔接或逻辑冲突；读者难以提取核心论点",
		},
	},

	emotional_resonance: {
		id: "emotional_resonance",
		layer: "offensive",
		label: "情感共鸣与情绪张力",
		description: "审查内容的情绪调动能力和代入感",
		sentinelPoints: [
			"情绪起伏曲线（铺垫→蓄力→释放）",
			"语言画面感与代入感",
			"情感推进节奏",
		],
		criteria: {
			green: "内容成功调动目标读者的情绪起伏；语言有画面感和代入感；情感推进有节奏；读者能产生「说的就是我」的认同",
			yellow: "内容有情绪但偏平——全程同一情绪基调无起伏；有画面感但缺乏代入感；情感表达偏直白，缺少留白和暗示的力量",
			red: "内容为纯信息堆砌，无情感层；语言干瘪无画面感；情绪推进为零——开头和结尾的情感温度相同；目标读者无法产生代入感",
		},
	},

	action_conversion: {
		id: "action_conversion",
		layer: "offensive",
		label: "用户行动转化率",
		description: "审查内容的CTA是否清晰有效，能否引导读者做出目标行为",
		sentinelPoints: [
			"CTA清晰度与紧迫感",
			"前置内容的动机铺垫充分度",
			"行动门槛与路径明确度",
		],
		criteria: {
			green: "CTA清晰、具体、有紧迫感；前置内容已完成充分的动机铺垫（痛点→方案→行动）；行动门槛低且路径明确；种草力/说服力足够",
			yellow: "CTA存在但模糊或缺乏驱动力；前置铺垫不充分，读者还没有行动的冲动；行动路径不清晰",
			red: "缺少CTA或CTA与内容脱节；全文未建立行动理由；读者看完不知道该做什么或不想做任何事",
		},
	},

	differentiation: {
		id: "differentiation",
		layer: "offensive",
		label: "差异化与记忆点",
		description: "审查内容在同品类中的辨识度和可记忆性",
		sentinelPoints: [
			"独特视角/表达方式/信息来源",
			"可被二次引用的概念锚点",
			"同品类内容替代性",
		],
		criteria: {
			green: "内容在同品类中有明确的辨识度——独特的视角/表达方式/信息来源；读者看完能记住至少一个「只有这篇才有的」观点或表达；有可被二次引用的概念锚点",
			yellow: "内容质量合格但与同类内容高度同质化；缺乏独特的记忆锚点——看完后难以回忆起具体说了什么；可被任意一篇同品类内容替代",
			red: "内容为行业通稿/模板化输出；与竞品内容高度相似；无任何独特视角、独家信息或差异化表达；读者看完会感觉「这篇我好像在哪里看过」",
		},
	},

	information_gap: {
		id: "information_gap",
		layer: "offensive",
		label: "信息差价值",
		description: "审查内容是否提供了目标读者通过常规渠道不易获取的信息",
		sentinelPoints: [
			"信息独占性（独家数据/一手经验/反常识洞察/内部视角）",
			"信息时效性与深度是否优于公开资料",
			"信息增量vs信息搬运",
		],
		criteria: {
			green: "内容提供了目标读者通过常规渠道不易获取的信息——独家数据/一手经验/反常识洞察/内部视角；信息的时效性或深度显著优于公开资料",
			yellow: "内容有信息量但未超出目标读者的常规认知边界——整合了公开信息但缺乏增量；观点正确但属于「正确的废话」；目标受众中已有一定比例知道这些信息",
			red: "内容未提供任何增量信息——全为百度可查的常识；或信息已过时，目标读者已从其他渠道获知；内容本质是信息搬运而非信息增值",
		},
	},
};

// ── Defensive dimension IDs (all, always active) ────────────────────────────

export const DEFENSIVE_DIMENSION_IDS: DefensiveDimensionId[] = [
	"social_risk_ethics",
	"legal_compliance",
	"context_distortion",
	"factual_integrity",
	"network_culture_risk",
];

// ── Offensive dimension IDs (all, user-selectable) ──────────────────────────

export const OFFENSIVE_DIMENSION_IDS: OffensiveDimensionId[] = [
	"hook_retention",
	"virality_potential",
	"narrative_structure",
	"emotional_resonance",
	"action_conversion",
	"differentiation",
	"information_gap",
];

// ── Default config (all offensive dimensions enabled) ───────────────────────

export const DEFAULT_DIMENSIONS_CONFIG: DimensionsConfig = {
	offensive: [...OFFENSIVE_DIMENSION_IDS],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Get all active dimension IDs (always includes defensive + configured offensive) */
export function getActiveDimensionIds(config: DimensionsConfig): DimensionId[] {
	return [...DEFENSIVE_DIMENSION_IDS, ...config.offensive] as DimensionId[];
}

/** Get dimension definitions for active dimensions (always includes defensive) */
export function getActiveDimensions(config: DimensionsConfig): DimensionDefinition[] {
	return getActiveDimensionIds(config).map((id) => DIMENSIONS[id]);
}

/** Validate that a set of offensive dimension IDs is valid */
export function isValidOffensiveSelection(ids: string[]): ids is OffensiveDimensionId[] {
	const valid = new Set<string>(OFFENSIVE_DIMENSION_IDS);
	return ids.every((id) => valid.has(id));
}

/** Build the dimension assessment table for prompts (defensive always included) */
export function buildDimensionTable(config: DimensionsConfig): string {
	const defensiveDefs = DEFENSIVE_DIMENSION_IDS.map(id => DIMENSIONS[id]);
	const offensiveDefs = config.offensive.map(id => DIMENSIONS[id]);

	const defensiveRows = defensiveDefs
		.map((d) => `| ${d.label} | 🟢/🟡/🔴 | （说明） |`)
		.join("\n");

	const offensiveRows = offensiveDefs
		.map((d) => `| ${d.label} | 🟢/🟡/🔴 | （说明） |`)
		.join("\n");

	let table = "#### 🛡️ 防御性风险评估（系统强制）\n\n";
	table += "| 维度 | 风险等级 | 说明 |\n";
	table += "|------|---------|------|\n";
	table += defensiveRows;

	if (offensiveRows) {
		table += "\n\n#### 🚀 进攻性价值评估\n\n";
		table += "| 维度 | 价值等级 | 说明 |\n";
		table += "|------|---------|------|\n";
		table += offensiveRows;
	}

	return table;
}

/** Build detailed criteria instructions for prompts (defensive always included) */
export function buildDimensionCriteriaInstructions(config: DimensionsConfig): string {
	const allDefs = [...DEFENSIVE_DIMENSION_IDS, ...config.offensive].map(id => DIMENSIONS[id]);
	const sections: string[] = [];

	for (const dim of allDefs) {
		let section = `### ${dim.label}（${dim.id}）\n\n`;
		section += `**审计目标**：${dim.description}\n\n`;
		section += `**审计哨点**：\n`;
		for (const sp of dim.sentinelPoints) {
			section += `- ${sp}\n`;
		}
		if (dim.conditionalSentinels && dim.conditionalSentinels.length > 0) {
			section += `\n**条件触发哨点**（内容涉及相关元素时激活）：\n`;
			for (const cs of dim.conditionalSentinels) {
				section += `- 触发条件：${cs.trigger} → ${cs.description}\n`;
			}
		}
		section += `\n**评分标准**：\n`;
		section += `- 🟢 ${dim.criteria.green}\n`;
		section += `- 🟡 ${dim.criteria.yellow}\n`;
		section += `- 🔴 ${dim.criteria.red}\n`;
		sections.push(section);
	}

	return sections.join("\n");
}

/** Format dimension list for user selection UI (defensive always shown as mandatory) */
export function formatDimensionSelectionList(): string {
	const lines: string[] = [];

	lines.push("**🛡️ 防御性维度（系统强制，所有评审员必须执行）：**\n");
	for (const id of DEFENSIVE_DIMENSION_IDS) {
		const dim = DIMENSIONS[id];
		lines.push(`- ${dim.label}：${dim.description}`);
	}

	lines.push("\n**🚀 进攻性维度（可选，回复编号取消选择）：**\n");
	OFFENSIVE_DIMENSION_IDS.forEach((id, i) => {
		const dim = DIMENSIONS[id];
		lines.push(`${i + 1}. ${dim.label}：${dim.description}`);
	});

	return lines.join("\n");
}

/** Parse user's dimension selection from wizard input */
export function parseDimensionSelection(
	input: string,
	currentConfig: DimensionsConfig
): DimensionsConfig {
	// If user says "all" or "全部", enable everything
	if (/全部|全选|所有|all/i.test(input)) {
		return { offensive: [...OFFENSIVE_DIMENSION_IDS] };
	}

	// Parse number indices to exclude (user picks numbers to DISABLE)
	const excludeIndices = new Set<number>();
	const numPattern = /\b([1-7])\b/g;
	let match;
	while ((match = numPattern.exec(input)) !== null) {
		excludeIndices.add(parseInt(match[1], 10));
	}

	const offensive = OFFENSIVE_DIMENSION_IDS.filter(
		(_, i) => !excludeIndices.has(i + 1)
	);

	return {
		offensive,
	};
}

// ── Defensive System Directive ──────────────────────────────────────────────
// Defensive dimensions are mandatory for ALL reviewers regardless of config.
// They are injected as a system-level directive appended to each reviewer's
// system prompt, ensuring compliance/safety checks are never skipped.

/** Build the mandatory defensive system directive to inject into every reviewer's system prompt */
export function buildDefensiveSystemDirective(): string {
	const defensiveDefs = DEFENSIVE_DIMENSION_IDS.map(id => DIMENSIONS[id]);

	let directive = "## 🛡️ 防御性风险评估（系统强制指令——必须执行）\n\n";
	directive += `以下 ${defensiveDefs.length} 项防御性维度是系统强制要求的审查项，不论你的角色定位如何，都必须对内容进行这些评估，不可跳过：\n\n`;

	for (const dim of defensiveDefs) {
		directive += `### ${dim.label}\n\n`;
		directive += `**审计目标**：${dim.description}\n\n`;
		directive += `**审计哨点**：\n`;
		for (const sp of dim.sentinelPoints) {
			directive += `- ${sp}\n`;
		}
		if (dim.conditionalSentinels && dim.conditionalSentinels.length > 0) {
			directive += `\n**条件触发哨点**（内容涉及相关元素时激活）：\n`;
			for (const cs of dim.conditionalSentinels) {
				directive += `- 触发条件：${cs.trigger} → ${cs.description}\n`;
			}
		}
		directive += `\n**评分标准**：\n`;
		directive += `- 🟢 ${dim.criteria.green}\n`;
		directive += `- 🟡 ${dim.criteria.yellow}\n`;
		directive += `- 🔴 ${dim.criteria.red}\n\n`;
	}

	directive += `请在你的评审结果中明确包含上述 ${defensiveDefs.length} 项防御性评估的结论。\n`;

	return directive;
}

/** Build the offensive dimension system directive for the given config */
export function buildOffensiveSystemDirective(config: DimensionsConfig): string {
	const offensiveDefs = config.offensive.map(id => DIMENSIONS[id]);
	if (offensiveDefs.length === 0) return "";

	let directive = "## 🚀 进攻性价值评估（必须执行）\n\n";
	directive += `以下 ${offensiveDefs.length} 项进攻性维度需要你进行评估，从这些维度审视内容的价值与效果：\n\n`;

	for (const dim of offensiveDefs) {
		directive += `### ${dim.label}\n\n`;
		directive += `**审计目标**：${dim.description}\n\n`;
		directive += `**审计哨点**：\n`;
		for (const sp of dim.sentinelPoints) {
			directive += `- ${sp}\n`;
		}
		directive += `\n**评分标准**：\n`;
		directive += `- 🟢 ${dim.criteria.green}\n`;
		directive += `- 🟡 ${dim.criteria.yellow}\n`;
		directive += `- 🔴 ${dim.criteria.red}\n\n`;
	}

	directive += "请在你的评审结果中明确包含上述进攻性维度的评估结论。\n";

	return directive;
}

/** Build the persona context directive from PersonaMeta fields + behavior hints */
export function buildPersonaContextDirective(meta: import("../utils/parser.js").PersonaMeta): string {
	const hints = meta.behaviorHints;
	const lines: string[] = ["## 👤 评审员画像\n\n以下是你作为评审员的身份属性，请严格以此身份进行评审：\n"];

	if (meta.ageRange) {
		lines.push(`- 年龄段：${meta.ageRange}`);
		if (hints?.ageRange) lines.push(`  → ${hints.ageRange}`);
	}
	if (meta.gender) {
		lines.push(`- 性别：${meta.gender}`);
		if (hints?.gender) lines.push(`  → ${hints.gender}`);
	}
	if (meta.tags && meta.tags.length > 0) {
		lines.push(`- 兴趣方向：${meta.tags.join("、")}`);
		if (hints?.tags) lines.push(`  → ${hints.tags}`);
	}
	if (meta.culturalContext) {
		lines.push(`- 文化背景：${meta.culturalContext}`);
		if (hints?.culturalContext) lines.push(`  → ${hints.culturalContext}`);
	}
	if (meta.dimensionBias?.perspective) {
		lines.push(`- 立场视角：${meta.dimensionBias.perspective}`);
		if (hints?.perspective) lines.push(`  → ${hints.perspective}`);
	}
	if (meta.blindSpot) {
		lines.push(`- 盲区：${meta.blindSpot}`);
		if (hints?.blindSpot) lines.push(`  → ${hints.blindSpot}`);
	}
	if (meta.authorRelation) {
		lines.push(`- 与作者关系：${meta.authorRelation}`);
		if (hints?.authorRelation) lines.push(`  → ${hints.authorRelation}`);
	}

	lines.push("");
	return lines.join("\n");
}

/** Build the tone directive with behavioral constraints */
export function buildToneDirective(tone: string | string[]): string {
	const toneList = Array.isArray(tone) ? tone.join("、") : tone;
	if (!toneList) return "";

	// Generate positive and negative constraints based on tone keywords
	const positive: string[] = [];
	const negative: string[] = [];

	const toneStr = Array.isArray(tone) ? tone.join(" ") : tone;

	if (/犀利|毒舌|尖锐|直接|不客气/.test(toneStr)) {
		positive.push("评价一针见血，不绕弯子，不堆砌客套");
		positive.push("用具体的比喻或类比点出问题，而非抽象概括");
		negative.push("不要使用「综上所述」「笔者认为」等公文式表达");
	} else if (/温柔|耐心|暖心|治愈|柔软/.test(toneStr)) {
		positive.push("以理解和共情的方式指出问题，先肯定再建议");
		positive.push("用温暖但诚实的语言表达真实感受");
		negative.push("不要用冷酷或居高临下的语气批评");
	} else if (/幽默|风趣|调侃|讽刺|阴阳/.test(toneStr)) {
		positive.push("用巧妙的比喻或反讽揭示问题");
		positive.push("让批评有趣但不失深度");
		negative.push("不要变成纯段子手而忽略实质问题");
	} else if (/理性|冷静|分析|客观|专业/.test(toneStr)) {
		positive.push("用数据和逻辑论证观点，保持论述的严密性");
		positive.push("观点有层次，先说结论再展开论证");
		negative.push("不要堆砌术语或故作高深");
	} else if (/暴躁|急躁|没耐心|大白话/.test(toneStr)) {
		positive.push("直戳痛点，不废话铺垫，结论先行");
		positive.push("用最直白的大白话说出感受");
		negative.push("不要写长段落，不要铺垫背景");
	} else {
		positive.push("保持你自然的表达方式，让评价有个性");
		positive.push("观点明确，不模糊其词");
		negative.push("不要使用模板化或公文式表达");
	}

	let directive = `## 🎙️ 讲话语气\n\n你必须以「${toneList}」的语气进行评审输出。具体要求：`;
	for (const p of positive) {
		directive += `\n- ${p}`;
	}
	for (const n of negative) {
		directive += `\n- ${n}`;
	}
	directive += "\n- 可以尖锐/犀利/温柔（取决于你的设定），但必须基于你的维度判定，不可为风格而牺牲准确性";

	return directive;
}

/** Build the user message for content review, with dimension-referencing instructions */
export function buildReviewUserMessage(
	content: string,
	contextNote: string | undefined,
	dimensions: DimensionsConfig,
	preAuditReport?: any
): string {
	const defensiveLabels = DEFENSIVE_DIMENSION_IDS.map(id => DIMENSIONS[id].label);
	const offensiveLabels = dimensions.offensive.map(id => DIMENSIONS[id].label);

	let message = `请按照你的评审体系对以下内容进行严格审查。

## 评审要求

1. **进攻性维度评估**：按你被指定的评审维度逐一审查，不可跳过任何维度，不可合并维度结论。
2. **每个维度必须包含**：
   - 价值等级：🟢 / 🟡 / 🔴
   - 判定依据：引用内容中的具体表述，结合你自身身份属性说明为何触发该判定
   - 优化建议（🟡/🔴 时必填）：给出具体可执行的优化方向

3. **输出格式**：

### 🚀 进攻性价值评估
| 维度 | 等级 | 判定依据 | 优化建议 |
|------|------|---------|---------|`;

	for (const label of offensiveLabels) {
		message += `\n| ${label} | 🟢/🟡/🔴 | ... | ... |`;
	}

	message += `

### 综合结论
- 一句话总评：
- 最紧急修改项：
- 优先优化项：

---

`;

	if (contextNote) {
		message += `**发布平台 & 目标受众背景**：${contextNote}\n\n`;
	}

	if (preAuditReport && Array.isArray(preAuditReport.dimensions)) {
		const hasFindings = preAuditReport.dimensions.some((d: any) => d.findings && d.findings.length > 0);
		if (hasFindings) {
			message += `**🚨 系统初审预警**：\n\n以下是系统在初步审查中发现的潜在风险点。请结合你的角色身份，判断这些风险在你的圈层中是否真的会引爆，以及影响有多大：\n\n`;
			for (const audit of preAuditReport.dimensions) {
				if (audit.findings && audit.findings.length > 0) {
					message += `【${audit.name}】发现 ${audit.findings.length} 个潜在风险：\n`;
					for (const f of audit.findings) {
						message += `- 风险等级：${f.suggestedLevel || "未知"}\n`;
						message += `  - 风险内容：${f.keyword}\n`;
						message += `  - 触发原因：${f.trigger}\n`;
						message += `  - 风险描述：${f.riskDescription}\n`;
					}
					message += `\n`;
				}
			}
		}
	}

	message += content;
	return message;
}

// ── Dimension Bias (replaces Persona stance) ────────────────────────────────
// Formerly, personas had a "stance" field (e.g. "都市女性视角") which was a
// free-text label that implicitly influenced which dimensions the persona
// would weigh more heavily. This created a gap: the persona "believed" in
// certain dimensions but the review system had no way to act on that.
//
// DimensionBias closes this gap by making the mapping explicit:
//   - focusDimensions: which offensive dimensions this persona cares about most
//   - perspective:      natural-language description of the review perspective
//                        (replaces the old stance text for prompt generation)

export type DimensionBiasWeight = "focus" | "default";

export interface DimensionBiasEntry {
	dimension: OffensiveDimensionId;
	weight: DimensionBiasWeight;
}

export interface DimensionBias {
	/** Which offensive dimensions this persona focuses on / weighs more */
	entries: DimensionBiasEntry[];
	/** Natural-language description of the persona's review perspective */
	perspective: string;
}

// ── Stance-to-DimensionBias mapping ──────────────────────────────────────────
// Maps the old 10 stance presets to explicit dimension bias + perspective.
// This is used both for backward-compatible migration and for the wizard UI.

interface StanceMapping {
	/** Human-readable label shown in the wizard */
	label: string;
	/** Offensive dimensions this perspective focuses on */
	focusDimensions: OffensiveDimensionId[];
	/** Natural-language perspective description (replaces old stance text) */
	perspective: string;
}

export const STANCE_TO_DIMENSION_BIAS: Record<string, StanceMapping> = {
	traditional_culture: {
		label: "关注传统文化表达、本土品牌与文化认同感",
		focusDimensions: ["differentiation", "emotional_resonance"],
		perspective: "关注传统文化表达、本土品牌与文化认同感的用户视角",
	},
	workplace_comm: {
		label: "关注职场沟通体验、表达方式与实际使用场景",
		focusDimensions: ["narrative_structure", "information_gap"],
		perspective: "关注职场沟通体验、表达方式与实际使用场景的职场用户视角",
	},
	urban_female: {
		label: "关注措辞细节、情绪表达与社会议题感受",
		focusDimensions: ["emotional_resonance", "virality_potential"],
		perspective: "关注措辞细节、情绪表达与社会议题感受的都市女性视角",
	},
	rational_analyst: {
		label: "关注逻辑结构、信息准确度与技术细节",
		focusDimensions: ["information_gap", "narrative_structure"],
		perspective: "关注逻辑结构、信息准确度与技术细节的理性分析视角",
	},
	public_opinion: {
		label: "容易受到公共讨论氛围与评论区情绪影响",
		focusDimensions: ["virality_potential", "emotional_resonance"],
		perspective: "容易受到公共讨论氛围与评论区情绪影响的大众用户视角",
	},
	independent_thinker: {
		label: "强调个体表达、价值一致性与真实感受",
		focusDimensions: ["differentiation", "information_gap"],
		perspective: "强调个体表达、价值一致性与真实感受的独立思考视角",
	},
	commercial_observer: {
		label: "关注商业表达、营销语言与消费真实性",
		focusDimensions: ["action_conversion", "information_gap"],
		perspective: "关注商业表达、营销语言与消费真实性的商业观察视角",
	},
	family_tradition: {
		label: "关注家庭观念、代际关系与传统价值表达",
		focusDimensions: ["emotional_resonance", "differentiation"],
		perspective: "关注家庭观念、代际关系与传统价值表达的传统文化视角",
	},
	community_core: {
		label: "关注圈层表达习惯与社区氛围",
		focusDimensions: ["virality_potential", "differentiation"],
		perspective: "熟悉垂直社区文化、关注圈层表达习惯与社区氛围的核心玩家视角",
	},
};

/** All available perspective presets for the wizard UI (ordered list) */
export const PERSPECTIVE_PRESETS: Array<{ id: string; label: string }> = [
	{ id: "traditional_culture", label: STANCE_TO_DIMENSION_BIAS.traditional_culture.label },
	{ id: "workplace_comm",     label: STANCE_TO_DIMENSION_BIAS.workplace_comm.label },
	{ id: "urban_female",      label: STANCE_TO_DIMENSION_BIAS.urban_female.label },
	{ id: "rational_analyst",  label: STANCE_TO_DIMENSION_BIAS.rational_analyst.label },
	{ id: "public_opinion",    label: STANCE_TO_DIMENSION_BIAS.public_opinion.label },
	{ id: "independent_thinker", label: STANCE_TO_DIMENSION_BIAS.independent_thinker.label },
	{ id: "commercial_observer", label: STANCE_TO_DIMENSION_BIAS.commercial_observer.label },
	{ id: "family_tradition",  label: STANCE_TO_DIMENSION_BIAS.family_tradition.label },
	{ id: "community_core",    label: STANCE_TO_DIMENSION_BIAS.community_core.label },
];

/** Build a DimensionBias from a preset ID (or IDs, for multi-select) */
export function buildDimensionBiasFromPresets(presetIds: string[], customPerspective?: string): DimensionBias {
	const entries: DimensionBiasEntry[] = [];
	const focusSet = new Set<OffensiveDimensionId>();

	for (const id of presetIds) {
		const mapping = STANCE_TO_DIMENSION_BIAS[id];
		if (mapping) {
			for (const dim of mapping.focusDimensions) {
				focusSet.add(dim);
			}
		}
	}

	// All focus dimensions → "focus" weight; the rest → "default"
	for (const dim of OFFENSIVE_DIMENSION_IDS) {
		entries.push({
			dimension: dim,
			weight: focusSet.has(dim) ? "focus" : "default",
		});
	}

	// Build perspective from selected presets
	const perspectives: string[] = [];
	for (const id of presetIds) {
		const mapping = STANCE_TO_DIMENSION_BIAS[id];
		if (mapping) perspectives.push(mapping.perspective);
	}

	return {
		entries,
		perspective: customPerspective || perspectives.join("；同时具备"),
	};
}

/** Build a DimensionBias from raw perspective text (backward compat for old stance values) */
export function buildDimensionBiasFromPerspective(perspectiveText: string): DimensionBias {
	// Try to match against known stance patterns to infer focus dimensions
	const focusDimensions = new Set<OffensiveDimensionId>();

	if (/女性|情绪|感受|措辞/.test(perspectiveText)) {
		focusDimensions.add("emotional_resonance");
		focusDimensions.add("virality_potential");
	}
	if (/逻辑|信息|准确|技术|理性/.test(perspectiveText)) {
		focusDimensions.add("information_gap");
		focusDimensions.add("narrative_structure");
	}
	if (/商业|营销|消费|转化/.test(perspectiveText)) {
		focusDimensions.add("action_conversion");
		focusDimensions.add("information_gap");
	}
	if (/传统|家庭|代际|文化认同/.test(perspectiveText)) {
		focusDimensions.add("emotional_resonance");
		focusDimensions.add("differentiation");
	}
	if (/社区|圈层|氛围|玩家/.test(perspectiveText)) {
		focusDimensions.add("virality_potential");
		focusDimensions.add("differentiation");
	}
	if (/职场|沟通|场景/.test(perspectiveText)) {
		focusDimensions.add("narrative_structure");
		focusDimensions.add("information_gap");
	}
	if (/独立|个体|价值|真实/.test(perspectiveText)) {
		focusDimensions.add("differentiation");
		focusDimensions.add("information_gap");
	}
	if (/大众|公共|舆论|评论区/.test(perspectiveText)) {
		focusDimensions.add("virality_potential");
		focusDimensions.add("emotional_resonance");
	}

	const entries: DimensionBiasEntry[] = OFFENSIVE_DIMENSION_IDS.map(dim => ({
		dimension: dim,
		weight: focusDimensions.has(dim) ? "focus" : "default" as DimensionBiasWeight,
	}));

	return {
		entries,
		perspective: perspectiveText,
	};
}

/** Get the list of focus dimension IDs from a DimensionBias */
export function getFocusDimensions(bias: DimensionBias): OffensiveDimensionId[] {
	return bias.entries
		.filter(e => e.weight === "focus")
		.map(e => e.dimension);
}

/** Build a human-readable bias summary for the persona preview */
export function formatDimensionBiasSummary(bias: DimensionBias): string {
	const focusDims = getFocusDimensions(bias);
	if (focusDims.length === 0) {
		return `视角：${bias.perspective}（无特别偏重维度）`;
	}
	const labels = focusDims.map(id => DIMENSIONS[id]?.label || id);
	return `视角：${bias.perspective}（重点关注：${labels.join("、")}）`;
}

/** Migrate a legacy stance value (string or string[]) to DimensionBias */
export function migrateStanceToBias(stance: string | string[] | undefined): DimensionBias | undefined {
	if (!stance) return undefined;

	const stances = Array.isArray(stance) ? stance : [stance];
	const presetIds: string[] = [];
	const customParts: string[] = [];

	for (const s of stances) {
		const trimmed = s.trim();
		// Check if it matches a known preset
		let matched = false;
		for (const [id, mapping] of Object.entries(STANCE_TO_DIMENSION_BIAS)) {
			if (trimmed === mapping.perspective || trimmed === mapping.label) {
				presetIds.push(id);
				matched = true;
				break;
			}
		}
		if (!matched) {
			customParts.push(trimmed);
		}
	}

	if (presetIds.length > 0 && customParts.length === 0) {
		return buildDimensionBiasFromPresets(presetIds);
	}

	// Fallback: build from perspective text
	return buildDimensionBiasFromPerspective(
		customParts.length > 0 ? customParts.join("；同时具备") : stances.join("；同时具备")
	);
}

// ── RST v1 — Reaction Simulation Taxonomy ────────────────────────────────────
// 四层互联网反应模拟人格系统：
//   L1 Archetype   → 基础反馈人格（决定评论角度 + 默认 focus 维度）
//   L2 Trigger     → 内容敏感触发器（决定哪些表达会引发强烈反应）
//   L3 Regional    → 地区文化过滤器（提高/降低特定 Trigger 的权重）
//   L4 Platform    → 平台文化层（决定表达习惯 + 内容期待）

// ── L1 Archetype ────────────────────────────────────────────────────────────

export type ArchetypeId =
	| "pragmatic_consumer"       // 实用主义消费者
	| "technical_reviewer"       // 技术真实性审查者
	| "low_attention_reader"     // 注意力稀缺型路人
	| "anti_marketing_detector"  // 反营销敏感者
	| "emotional_reactor"        // 情绪直觉型用户
	| "logic_hunter"             // 逻辑漏洞猎手
	| "social_value_observer"    // 社会价值观察者
	| "subculture_gatekeeper";   // 亚文化圈层守门人

export interface ArchetypeDefinition {
	id: ArchetypeId;
	label: string;
	description: string;
	/** Which offensive dimensions this archetype focuses on */
	focusDimensions: OffensiveDimensionId[];
	/** Default perspective description */
	perspective: string;
}

export const RST_ARCHETYPES: Record<ArchetypeId, ArchetypeDefinition> = {
	pragmatic_consumer: {
		id: "pragmatic_consumer",
		label: "实用主义消费者",
		description: "关注价格与实际价值，讨厌空洞愿景，反感'讲故事不讲功能'",
		focusDimensions: ["hook_retention", "action_conversion"],
		perspective: "以实际使用价值和性价比为核心标准的内容消费者视角",
	},
	technical_reviewer: {
		id: "technical_reviewer",
		label: "技术真实性审查者",
		description: "审查技术逻辑，对 buzzword 高敏感，关注隐私、架构、实现合理性",
		focusDimensions: ["information_gap", "narrative_structure"],
		perspective: "以技术实现真实性和逻辑严谨性为核心标准的审查视角",
	},
	low_attention_reader: {
		id: "low_attention_reader",
		label: "注意力稀缺型路人",
		description: "极短阅读耐心，快速滑动，不愿理解复杂上下文",
		focusDimensions: ["hook_retention", "narrative_structure"],
		perspective: "以极短注意力窗口和快速判断为特征的路人视角",
	},
	anti_marketing_detector: {
		id: "anti_marketing_detector",
		label: "反营销敏感者",
		description: "对营销语言极度敏感，反感'重新定义''颠覆''革命性'",
		focusDimensions: ["differentiation", "action_conversion"],
		perspective: "对营销包装和商业话术高度警觉的反营销视角",
	},
	emotional_reactor: {
		id: "emotional_reactor",
		label: "情绪直觉型用户",
		description: "优先感知语气与情绪，容易被措辞影响，对'高高在上感'敏感",
		focusDimensions: ["emotional_resonance", "virality_potential"],
		perspective: "以情绪感知和直觉反应为判断核心的感性视角",
	},
	logic_hunter: {
		id: "logic_hunter",
		label: "逻辑漏洞猎手",
		description: "喜欢找矛盾，放大文本漏洞，容易质疑论证链",
		focusDimensions: ["information_gap", "differentiation"],
		perspective: "以逻辑一致性和论证严谨性为核心标准的审查视角",
	},
	social_value_observer: {
		id: "social_value_observer",
		label: "社会价值观察者",
		description: "关注社会影响，关注价值导向，关注表达是否伤害群体",
		focusDimensions: ["emotional_resonance", "virality_potential"],
		perspective: "以社会影响和群体价值为导向的观察视角",
	},
	subculture_gatekeeper: {
		id: "subculture_gatekeeper",
		label: "亚文化圈层守门人",
		description: "强烈圈层意识，对 outsider 极其敏感，反感'蹭文化'",
		focusDimensions: ["differentiation", "virality_potential"],
		perspective: "以圈层纯度和文化真实性为核心标准的守门人视角",
	},
};

/** Build DimensionBias from one or two ArchetypeIds */
export function buildDimensionBiasFromArchetypes(archetypeIds: ArchetypeId[]): DimensionBias {
	const focusSet = new Set<OffensiveDimensionId>();
	const perspectives: string[] = [];

	for (const id of archetypeIds) {
		const def = RST_ARCHETYPES[id];
		if (!def) continue;
		for (const dim of def.focusDimensions) focusSet.add(dim);
		perspectives.push(def.perspective);
	}

	const entries: DimensionBiasEntry[] = OFFENSIVE_DIMENSION_IDS.map(dim => ({
		dimension: dim,
		weight: focusSet.has(dim) ? "focus" : "default",
	}));

	return {
		entries,
		perspective: perspectives.join("；同时具备"),
	};
}

// ── L2 Trigger ──────────────────────────────────────────────────────────────

export type TriggerId =
	| "jargon_density"           // 黑话密度敏感
	| "ai_writing"               // AI 味敏感
	| "preachy_tone"             // 说教感敏感
	| "pretentious"              // 装腔感敏感
	| "clickbait"                // 标题党审查
	| "slow_pacing"              // 节奏拖沓敏感
	| "info_density_imbalance"   // 信息密度失衡
	| "gender_expression"        // 性别表达敏感
	| "class_expression"         // 阶层表达敏感
	| "identity_politics"        // 身份政治敏感
	| "corporate_responsibility" // 企业责任敏感
	| "authenticity_check"       // 真实性审查
	| "data_credibility"         // 数据可信度审查
	| "overhyped";               // 过度包装审查

export type TriggerCategory = "expression" | "propagation" | "social_issue" | "authenticity";

export interface TriggerDefinition {
	id: TriggerId;
	label: string;
	category: TriggerCategory;
	description: string;
	/** Which auditor IDs this trigger is interested in findings from */
	retainedAuditors: string[];
	/** Optional: specific trigger keyword patterns to match in finding.trigger */
	retainedPatterns?: string[];
}

export const RST_TRIGGERS: Record<TriggerId, TriggerDefinition> = {
	jargon_density: {
		id: "jargon_density",
		label: "黑话密度敏感",
		category: "expression",
		description: "讨厌 jargon，反感行业术语堆砌",
		retainedAuditors: ["network_culture_risk"],
		retainedPatterns: ["黑话", "术语", "行话", "缩写"],
	},
	ai_writing: {
		id: "ai_writing",
		label: "AI 味敏感",
		category: "expression",
		description: "对 AI 写作痕迹敏感，讨厌模板化表达",
		retainedAuditors: ["network_culture_risk", "context_distortion"],
		retainedPatterns: ["模板", "套话", "万能句式"],
	},
	preachy_tone: {
		id: "preachy_tone",
		label: "说教感敏感",
		category: "expression",
		description: "反感居高临下，讨厌教育用户",
		retainedAuditors: ["social_risk"],
		retainedPatterns: ["说教", "居高临下", "优越感", "精英"],
	},
	pretentious: {
		id: "pretentious",
		label: "装腔感敏感",
		category: "expression",
		description: "反感故作深刻，讨厌'故意高级'",
		retainedAuditors: ["social_risk"],
		retainedPatterns: ["装", "做作", "故作", "矫情"],
	},
	clickbait: {
		id: "clickbait",
		label: "标题党审查",
		category: "propagation",
		description: "检测夸张标题，关注标题与正文偏差",
		retainedAuditors: ["context_distortion"],
		retainedPatterns: ["标题", "正文", "偏差", "夸张"],
	},
	slow_pacing: {
		id: "slow_pacing",
		label: "节奏拖沓敏感",
		category: "propagation",
		description: "反感铺垫过长，希望快速进入重点",
		retainedAuditors: ["factual_integrity"],
		retainedPatterns: ["冗余", "拖沓", "铺垫", "信息密度"],
	},
	info_density_imbalance: {
		id: "info_density_imbalance",
		label: "信息密度失衡",
		category: "propagation",
		description: "太空洞或信息爆炸",
		retainedAuditors: ["factual_integrity"],
		retainedPatterns: ["空洞", "信息密度", "冗余"],
	},
	gender_expression: {
		id: "gender_expression",
		label: "性别表达敏感",
		category: "social_issue",
		description: "对性别刻板印象高敏感",
		retainedAuditors: ["social_risk"],
		retainedPatterns: ["性别", "刻板印象", "男", "女"],
	},
	class_expression: {
		id: "class_expression",
		label: "阶层表达敏感",
		category: "social_issue",
		description: "对优越感、高位叙事敏感",
		retainedAuditors: ["social_risk"],
		retainedPatterns: ["阶层", "优越感", "精英", "凡尔赛"],
	},
	identity_politics: {
		id: "identity_politics",
		label: "身份政治敏感",
		category: "social_issue",
		description: "对群体标签敏感",
		retainedAuditors: ["social_risk", "network_culture_risk"],
		retainedPatterns: ["身份", "群体", "标签", "对立"],
	},
	corporate_responsibility: {
		id: "corporate_responsibility",
		label: "企业责任敏感",
		category: "social_issue",
		description: "对 CSR、环保、劳工问题敏感",
		retainedAuditors: ["social_risk"],
		retainedPatterns: ["企业", "环保", "劳工", "CSR", "ESG"],
	},
	authenticity_check: {
		id: "authenticity_check",
		label: "真实性审查",
		category: "authenticity",
		description: "怀疑'编故事'，关注真实经历",
		retainedAuditors: ["factual_integrity"],
		retainedPatterns: ["编造", "故事", "真实", "经历"],
	},
	data_credibility: {
		id: "data_credibility",
		label: "数据可信度审查",
		category: "authenticity",
		description: "怀疑统计与案例真实性",
		retainedAuditors: ["factual_integrity"],
		retainedPatterns: ["数据", "统计", "来源", "出处"],
	},
	overhyped: {
		id: "overhyped",
		label: "过度包装审查",
		category: "authenticity",
		description: "反感'包装大于产品'",
		retainedAuditors: ["legal_compliance", "social_risk"],
		retainedPatterns: ["包装", "夸大", "绝对", "最"],
	},
};

/** All trigger IDs as an array */
export const ALL_TRIGGER_IDS: TriggerId[] = Object.keys(RST_TRIGGERS) as TriggerId[];

// ── L3 Regional Pack ────────────────────────────────────────────────────────

export type RegionalPackId =
	| "china"
	| "north_america"
	| "japan"
	| "korea"
	| "southeast_asia";

export interface RegionalPackDefinition {
	id: RegionalPackId;
	label: string;
	/** Trigger ID → weight multiplier (only overrides >1.0 listed) */
	triggerMultipliers: Partial<Record<TriggerId, number>>;
}

export const RST_REGIONAL_PACKS: Record<RegionalPackId, RegionalPackDefinition> = {
	china: {
		id: "china",
		label: "中国大陆语境",
		triggerMultipliers: {
			preachy_tone: 2.0,
			class_expression: 1.8,
			gender_expression: 1.5,
			overhyped: 1.3,
			ai_writing: 1.2,
			clickbait: 1.4,
		},
	},
	north_america: {
		id: "north_america",
		label: "北美语境",
		triggerMultipliers: {
			identity_politics: 2.0,
			corporate_responsibility: 1.5,
			gender_expression: 1.5,
			overhyped: 1.3,
			pretentious: 1.2,
			authenticity_check: 1.2,
		},
	},
	japan: {
		id: "japan",
		label: "日本语境",
		triggerMultipliers: {
			pretentious: 1.5,
			corporate_responsibility: 1.3,
			preachy_tone: 1.4,
			class_expression: 1.3,
			slow_pacing: 1.2,
		},
	},
	korea: {
		id: "korea",
		label: "韩国语境",
		triggerMultipliers: {
			class_expression: 2.0,
			authenticity_check: 1.3,
			pretentious: 1.4,
			gender_expression: 1.3,
			overhyped: 1.2,
		},
	},
	southeast_asia: {
		id: "southeast_asia",
		label: "东南亚语境",
		triggerMultipliers: {
			identity_politics: 1.4,
			corporate_responsibility: 1.3,
			pretentious: 1.3,
			class_expression: 1.2,
		},
	},
};

// ── L4 Platform Culture ─────────────────────────────────────────────────────

export type PlatformCultureId =
	| "hacker_news"
	| "reddit"
	| "twitter"
	| "v2ex"
	| "xiaohongshu"
	| "zhihu"
	| "douyin"
	| "weibo"
	| "bilibili"
	| "wechat_official"
	| "instagram"
	| "youtube";

export interface PlatformCultureDefinition {
	id: PlatformCultureId;
	label: string;
	characteristics: string;
	/** Behavioral constraints for the reviewer's output style */
	outputConstraints: string[];
	/** Trigger weight adjustments specific to this platform */
	triggerAdjustments: Partial<Record<TriggerId, number>>;
}

export const RST_PLATFORM_CULTURES: Record<PlatformCultureId, PlatformCultureDefinition> = {
	hacker_news: {
		id: "hacker_news",
		label: "Hacker News",
		characteristics: "极度反营销、崇尚 technical honesty、讨厌 buzzword",
		outputConstraints: [
			"输出必须包含技术质疑",
			"对'X for Y'式标题直接嘲讽",
			"禁止公司公关口吻",
			"偏好技术细节和架构讨论",
		],
		triggerAdjustments: {
			ai_writing: 1.5,
			overhyped: 1.5,
			jargon_density: 1.3,
			preachy_tone: 1.2,
			pretentious: 1.3,
		},
	},
	reddit: {
		id: "reddit",
		label: "Reddit",
		characteristics: "情绪化社区、讨厌 corporate tone、亚文化浓厚",
		outputConstraints: [
			"输出情绪化，可使用社区梗",
			"频繁引用 subreddit 文化",
			"讨厌 corporate tone",
			"可使用大写字母表达强烈情绪",
		],
		triggerAdjustments: {
			pretentious: 1.3,
			corporate_responsibility: 1.2,
			ai_writing: 1.2,
			preachy_tone: 1.1,
		},
	},
	twitter: {
		id: "twitter",
		label: "X / Twitter",
		characteristics: "极短注意力、情绪优先传播、标题决定生死",
		outputConstraints: [
			"输出限制在 280 字以内",
			"结论前置",
			"情绪烈度高于信息密度",
			"可使用 thread 形式展开",
		],
		triggerAdjustments: {
			slow_pacing: 1.5,
			clickbait: 1.3,
			ai_writing: 1.1,
		},
	},
	v2ex: {
		id: "v2ex",
		label: "V2EX",
		characteristics: "对'装'极度敏感、崇尚真实经历、反感营销黑话",
		outputConstraints: [
			"输出必须有'个人经历'支撑",
			"装腔者直接 tag",
			"偏好 OP 诚实陈述",
			"技术话题优先",
		],
		triggerAdjustments: {
			pretentious: 1.8,
			overhyped: 1.5,
			jargon_density: 1.3,
			ai_writing: 1.4,
			class_expression: 1.2,
		},
	},
	xiaohongshu: {
		id: "xiaohongshu",
		label: "小红书",
		characteristics: "情绪真实性优先、对'广告感'极其敏感、重视生活感与细节感",
		outputConstraints: [
			"输出必须有'真实体验感'",
			"广告感内容一律差评",
			"重视 emoji 和排版",
			"偏好生活化场景描述",
		],
		triggerAdjustments: {
			ai_writing: 1.5,
			overhyped: 1.8,
			preachy_tone: 1.3,
			pretentious: 1.2,
			clickbait: 1.3,
		},
	},
	zhihu: {
		id: "zhihu",
		label: "知乎",
		characteristics: "崇尚理性讨论、反感情感宣泄、偏好信息密度",
		outputConstraints: [
			"输出结构完整、逻辑自洽",
			"反感情感宣泄",
			"偏好数据论证",
			"可引用专业来源",
		],
		triggerAdjustments: {
			preachy_tone: 1.3,
			ai_writing: 1.2,
			pretentious: 1.3,
			class_expression: 1.2,
		},
	},
	douyin: {
		id: "douyin",
		label: "抖音",
		characteristics: "短视频优先、娱乐化导向、算法推荐驱动、评论区梗文化盛行",
		outputConstraints: [
			"输出必须适配短视频场景",
			"语言直白、口语化",
			"重视'梗'和网络流行语",
			"评论区互动感强",
		],
		triggerAdjustments: {
			slow_pacing: 1.6,
			ai_writing: 1.3,
			overhyped: 1.4,
			clickbait: 1.4,
		},
	},
	weibo: {
		id: "weibo",
		label: "微博",
		characteristics: "热搜驱动、情绪化传播、饭圈文化影响、公共议题发酵地",
		outputConstraints: [
			"输出适配碎片化阅读",
			"可使用话题标签",
			"情绪表达优先",
			"重视转发和评论互动",
		],
		triggerAdjustments: {
			clickbait: 1.4,
			preachy_tone: 1.3,
			identity_politics: 1.4,
			gender_expression: 1.3,
		},
	},
	bilibili: {
		id: "bilibili",
		label: "B站",
		characteristics: "二次元文化根基、弹幕互动、UP主生态、技术宅聚集",
		outputConstraints: [
			"输出需理解弹幕文化",
			"可使用二次元梗",
			"技术内容受欢迎",
			"真实体验优先于营销",
		],
		triggerAdjustments: {
			ai_writing: 1.4,
			pretentious: 1.5,
			overhyped: 1.3,
			jargon_density: 1.2,
		},
	},
	wechat_official: {
		id: "wechat_official",
		label: "微信公众号",
		characteristics: "深度阅读场景、订阅制分发、公众号品牌调性、朋友圈传播",
		outputConstraints: [
			"输出适配长文阅读",
			"结构清晰有层次",
			"避免过度标题党",
			"重视内容深度",
		],
		triggerAdjustments: {
			clickbait: 1.5,
			slow_pacing: 1.3,
			ai_writing: 1.2,
			overhyped: 1.3,
		},
	},
	instagram: {
		id: "instagram",
		label: "Instagram",
		characteristics: "视觉优先、生活方式展示、影响者文化、品牌合作密集",
		outputConstraints: [
			"输出需考虑视觉搭配",
			"语言简洁有格调",
			"重视审美和生活感",
			"可使用 emoji 和 hashtag",
		],
		triggerAdjustments: {
			overhyped: 1.4,
			ai_writing: 1.2,
			preachy_tone: 1.3,
		},
	},
	youtube: {
		id: "youtube",
		label: "YouTube",
		characteristics: "长视频内容、订阅+算法双驱动、创作者生态、评论区文化",
		outputConstraints: [
			"输出适配视频评论场景",
			"可引用视频时间戳",
			"技术评测需具体",
			"重视创作者互动",
		],
		triggerAdjustments: {
			slow_pacing: 1.3,
			ai_writing: 1.2,
			overhyped: 1.3,
			clickbait: 1.2,
		},
	},
};

// ── RST Config (composed persona) ───────────────────────────────────────────

export interface RSTConfig {
	archetypes: ArchetypeId[];
	triggers: TriggerId[];
	regionalPack: RegionalPackId;
	platformCulture: PlatformCultureId;
}

/** Build DimensionBias from a full RSTConfig */
export function buildDimensionBiasFromRST(rst: RSTConfig): DimensionBias {
	return buildDimensionBiasFromArchetypes(rst.archetypes);
}

/** Get effective trigger weights after applying regional + platform multipliers */
export function getEffectiveTriggerWeights(rst: RSTConfig): Record<TriggerId, number> {
	const weights: Record<TriggerId, number> = {} as Record<TriggerId, number>;
	for (const id of ALL_TRIGGER_IDS) weights[id] = 1.0;
	const region = RST_REGIONAL_PACKS[rst.regionalPack];
	const platform = RST_PLATFORM_CULTURES[rst.platformCulture];

	for (const triggerId of ALL_TRIGGER_IDS) {
		if (region?.triggerMultipliers[triggerId]) weights[triggerId] *= region.triggerMultipliers[triggerId]!;
		if (platform?.triggerAdjustments[triggerId]) weights[triggerId] *= platform.triggerAdjustments[triggerId]!;
	}
	return weights;
}
