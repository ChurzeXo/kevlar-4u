import { t, getCurrentLanguage } from "./index.js";

const NS = "wizard";

export function getAgeRangeChoices(): string {
	const locale = getCurrentLanguage();
	if (locale === "zh-CN") {
		return `1. 18岁以下
2. 18-24岁
3. 25-30岁
4. 30-35岁
5. 35-40岁
6. 40岁以上`;
	}
	return `1. Under 18
2. 18-24 years old
3. 25-30 years old
4. 30-35 years old
5. 35-40 years old
6. Over 40`;
}

export function getStepQuestion(step: string): string {
	return t(`${step}.prompt`, { ns: NS });
}

export function getAuthorRelationPrompt(): string {
	const locale = getCurrentLanguage();
	if (locale === "zh-CN") {
		return `请选择这个角色与作者的关系（回复编号）：

1. 已关注（信任阈值较高，但期望值也更高）
2. 未关注（信任阈值较低，更容易因细节问题流失注意力）`;
	}
	return `Please select this character's relation to the author (reply with number):

1. Followed (higher trust threshold, but also higher expectations)
2. Not followed (lower trust threshold, more likely to lose attention due to details)`;
}

export function getAgeRangeOptions(): Array<{ value: string; label: string }> {
	const locale = getCurrentLanguage();
	if (locale === "zh-CN") {
		return [
			{ value: "18岁以下", label: "18岁以下" },
			{ value: "18-24岁", label: "18-24岁" },
			{ value: "25-30岁", label: "25-30岁" },
			{ value: "30-35岁", label: "30-35岁" },
			{ value: "35-40岁", label: "35-40岁" },
			{ value: "40岁以上", label: "40岁以上" },
		];
	}
	return [
		{ value: "Under 18", label: "Under 18" },
		{ value: "18-24 years old", label: "18-24 years old" },
		{ value: "25-30 years old", label: "25-30 years old" },
		{ value: "30-35 years old", label: "30-35 years old" },
		{ value: "35-40 years old", label: "35-40 years old" },
		{ value: "Over 40", label: "Over 40" },
	];
}

export function getShortFieldLabel(field: string): string {
	const locale = getCurrentLanguage();
	const labels: Record<string, Record<string, string>> = {
		"zh-CN": {
			ageRange: "年龄段",
			interests: "兴趣",
			traits: "性格",
			tone: "语气",
			platform: "平台",
			authorRelation: "关系",
			perspective: "视角",
		},
		"en-US": {
			ageRange: "age range",
			interests: "interests",
			traits: "traits",
			tone: "tone",
			platform: "platform",
			authorRelation: "relation",
			perspective: "perspective",
		},
	};
	return labels[locale]?.[field] || field;
}

export function getChineseNumber(n: number): string {
	const locale = getCurrentLanguage();
	if (locale === "zh-CN") {
		return ["一", "二", "三", "四", "五", "六", "七"][n - 1] || String(n);
	}
	return String(n);
}

export function getGoBackHint(step: string): string {
	const locale = getCurrentLanguage();
	const label = getShortFieldLabel(step);
	const stepIdx = STEP_ORDER.indexOf(step);
	const backNum = stepIdx > 0 ? getChineseNumber(stepIdx + 1) : null;

	if (locale === "zh-CN") {
		return backNum
			? `（如需修改之前的选择，可说「重新设置${label}」或「回到第${backNum}步」）`
			: `（如需修改之前的选择，可说「重新设置${label}」）`;
	}
	return backNum
		? `(To modify previous selections, say "change ${label}" or "go back to step ${backNum}")`
		: `(To modify previous selections, say "change ${label}")`;
}

export function getCustomPerspectiveOption(): string {
	const locale = getCurrentLanguage();
	return locale === "zh-CN" ? "自定义" : "Custom";
}

export function getInitialAgeRangePrompt(): string {
	const locale = getCurrentLanguage();
	if (locale === "zh-CN") {
		return [
			"请选择这个角色的年龄段（回复编号）：",
			"",
			getAgeRangeChoices(),
		].join("\n");
	}
	return [
		"Please select this character's age range (reply with number):",
		"",
		getAgeRangeChoices(),
	].join("\n");
}

export function getWizardFailedMessage(error: string): string {
	const locale = getCurrentLanguage();
	if (locale === "zh-CN") {
		return `❌ 人设创建向导失败：${error}`;
	}
	return `❌ Persona creation wizard failed: ${error}`;
}

export function getPleaseProvideReply(): string {
	const locale = getCurrentLanguage();
	return locale === "zh-CN"
		? "❌ 请提供当前步骤的用户回复。"
		: "❌ Please provide a reply for the current step.";
}

export function getRecordedMessage(value: string): string {
	const locale = getCurrentLanguage();
	return locale === "zh-CN" ? `已记录：${value}` : `Recorded: ${value}`;
}

export function getStepMessage(stepNumber: number, question: string): string {
	const locale = getCurrentLanguage();
	const num = getChineseNumber(stepNumber);
	return locale === "zh-CN"
		? `第${num}步：${question}`
		: `Step ${stepNumber}: ${question}`;
}

export function getInvalidChoiceMessage(options: string[]): string {
	const locale = getCurrentLanguage();
	const opts = options.map((p, i) => `${i + 1}. ${p}`).join("\n");
	if (locale === "zh-CN") {
		return ["无效选择，请从以下选项中选择：", "", opts, "", "回复编号或名称即可。"].join("\n");
	}
	return ["Invalid choice, please select from the following:", "", opts, "", "Reply with number or name."].join("\n");
}

export function getSelectOnePlatformMessage(platforms: string[]): string {
	const locale = getCurrentLanguage();
	const opts = platforms.map((p, i) => `${i + 1}. ${p}`).join("\n");
	if (locale === "zh-CN") {
		return [
			`一个评审员只针对一个平台。请从以下 ${platforms.length} 个平台中选择一个（回复编号即可）：`,
			"",
			opts,
		].join("\n");
	}
	return [
		`One reviewer targets one platform only. Please select one from the following ${platforms.length} platforms (reply with number):`,
		"",
		opts,
	].join("\n");
}

export function getPlatformSelectedMessage(platform: string): string {
	const locale = getCurrentLanguage();
	if (locale === "zh-CN") {
		return `你输入了多个平台，已选择「${platform}」。其他平台可另行创建评审员。`;
	}
	return `You entered multiple platforms. Selected "${platform}". You can create separate reviewers for other platforms.`;
}

export function getInvalidPlatformSelectionMessage(): string {
	const locale = getCurrentLanguage();
	return locale === "zh-CN"
		? "无效选择，请从以下平台中选一个："
		: "Invalid choice, please select one platform:";
}

export function getAuthorRelationOptions(): string {
	const locale = getCurrentLanguage();
	if (locale === "zh-CN") {
		return ["请从以下选项中选择（回复编号）：", "", "1. 已关注", "2. 未关注"].join("\n");
	}
	return ["Please select from the following (reply with number):", "", "1. Followed", "2. Not followed"].join("\n");
}

export function getPerspectiveSelectionPrompt(): string {
	const locale = getCurrentLanguage();
	if (locale === "zh-CN") {
		return "第七步：请选择这个评审员的审视视角（可多选，回复编号，多个用逗号分隔）：";
	}
	return "Step 7: Please select this reviewer's perspective (multiple selection, reply with numbers separated by commas):";
}

export function getPerspectiveSelectionHint(): string {
	const locale = getCurrentLanguage();
	if (locale === "zh-CN") {
		return "选择后，系统会自动为该视角匹配重点关注的评审维度。";
	}
	return "After selection, the system will automatically match focus dimensions for this perspective.";
}

export function getCustomPerspectivePrompt(): string {
	const locale = getCurrentLanguage();
	return locale === "zh-CN"
		? "请描述你评审员的审视视角："
		: "Please describe your reviewer's perspective:";
}

export function getCustomPerspectiveDescriptionPrompt(): string {
	const locale = getCurrentLanguage();
	return locale === "zh-CN"
		? "请描述该角色的审视视角与表达倾向："
		: "Please describe this character's perspective and expression tendency:";
}

export function getFinalConfirmPrompt(): string {
	const locale = getCurrentLanguage();
	return locale === "zh-CN"
		? "请说明要修改哪个字段：名字、性别、年龄段、兴趣方向、性格特质或常用平台。"
		: "Please specify which field to modify: name, gender, age range, interests, traits, or platform.";
}

export function getUpdatedFieldMessage(field: string): string {
	const locale = getCurrentLanguage();
	return locale === "zh-CN" ? `已更新${field}。` : `Updated ${field}.`;
}

export function getWizardCompletedMessage(): string {
	const locale = getCurrentLanguage();
	return locale === "zh-CN"
		? "这个人设创建流程已经完成。需要创建新角色时，请重新开始一个会话。"
		: "This persona creation process is complete. To create a new character, please start a new session.";
}

export function getInvalidSessionIdMessage(): string {
	const locale = getCurrentLanguage();
	return locale === "zh-CN"
		? "sessionId 格式不合法。"
		: "Invalid sessionId format.";
}

export function getPlatformNoteMessage(platform: string): string {
	const locale = getCurrentLanguage();
	if (locale === "zh-CN") {
		return `你输入了多个平台，已选择「${platform}」。其他平台可另行创建评审员。`;
	}
	return `You entered multiple platforms. Selected "${platform}". You can create separate reviewers for other platforms.`;
}

// Helper constant for step order (used in getGoBackHint)
const STEP_ORDER = [
	"ageRange",
	"interests",
	"traits",
	"tone",
	"platform",
	"authorRelation",
	"perspective",
	"finalConfirm",
	"completed",
];
