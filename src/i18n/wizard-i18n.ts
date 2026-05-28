import { t } from "./index.js";

const NS = "wizard";

export function getWizardCommon(key: string): string {
	return t(`common.${key}`, { ns: NS });
}

export function getWizardGoBack(step?: number): string {
	if (step) {
		return t("common.goBackTo", { ns: NS, step });
	}
	return t("common.goBack", { ns: NS });
}

export function getPlatformOption(key: string): string {
	return t(`platform.options.${key}`, { ns: NS });
}

export function getAgeRangeOption(key: string): string {
	return t(`ageRange.options.${key}`, { ns: NS });
}

export function getGenderOption(key: string): string {
	return t(`gender.options.${key}`, { ns: NS });
}

export function getInterestOption(key: string): string {
	return t(`interests.options.${key}`, { ns: NS });
}

export function getToneOption(key: string): string {
	return t(`tone.options.${key}`, { ns: NS });
}

export function getAuthorRelationOption(key: string): string {
	return t(`authorRelation.options.${key}`, { ns: NS });
}

export function getPerspectiveOption(key: string): string {
	return t(`perspective.options.${key}`, { ns: NS });
}

export function getPlatformPrompt(): string {
	return t("platform.prompt", { ns: NS });
}

export function getAgeRangePrompt(): string {
	return t("ageRange.prompt", { ns: NS });
}

export function getGenderPrompt(): string {
	return t("gender.prompt", { ns: NS });
}

export function getInterestsPrompt(): string {
	return t("interests.prompt", { ns: NS });
}

export function getTonePrompt(): string {
	return t("tone.prompt", { ns: NS });
}

export function getAuthorRelationPrompt(): string {
	return t("authorRelation.prompt", { ns: NS });
}

export function getPerspectivePrompt(): string {
	return t("perspective.prompt", { ns: NS });
}

export function getDimensionsPrompt(): string {
	return t("dimensions.prompt", { ns: NS });
}

export function getDimensionsDefensiveLabel(): string {
	return t("dimensions.defensive", { ns: NS });
}

export function getDimensionsOffensiveLabel(): string {
	return t("dimensions.offensive", { ns: NS });
}

export function getNamePrompt(): string {
	return t("name.prompt", { ns: NS });
}

export function getConfirmPrompt(): string {
	return t("confirm.prompt", { ns: NS });
}

export function getConfirmPreview(): string {
	return t("confirm.preview", { ns: NS });
}

export function getReviewContentInput(): string {
	return t("review.contentInput", { ns: NS });
}

export function getReviewPlatformNote(): string {
	return t("review.platformNote", { ns: NS });
}

export function getConfigureSelectMode(): string {
	return t("configure.selectMode", { ns: NS });
}

export function getConfigureSetConcurrency(): string {
	return t("configure.setConcurrency", { ns: NS });
}

export function getConfigureConfirmChanges(): string {
	return t("configure.confirmChanges", { ns: NS });
}

export function getDeleteSelectPersona(): string {
	return t("delete.selectPersona", { ns: NS });
}

export function getDeleteConfirmDelete(): string {
	return t("delete.confirmDelete", { ns: NS });
}

export function getDeleteMessage(message: string): string {
	return t(`delete.${message}`, { ns: NS });
}

export function getWizardError(key: string): string {
	return t(`errors.${key}`, { ns: NS });
}
