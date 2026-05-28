import { t } from "./index.js";

const NS = "tools";

export function getToolDescription(toolName: string): string {
	return t(`${toolName}.description`, { ns: NS });
}

export function getToolTitle(toolName: string): string {
	return t(`${toolName}.title`, { ns: NS });
}

export function getHelpText(): string {
	const overview = t("help.sections.overview", { ns: NS });
	const tools = t("help.sections.tools", { ns: NS });
	const faq = t("help.sections.faq", { ns: NS });
	return `${overview}\n\n${tools}\n\n${faq}`;
}

export function getWizardPrompt(wizardName: string, step: string): string {
	return t(`${wizardName}.prompts.${step}`, { ns: NS });
}

export function getWizardStep(wizardName: string, step: string): string {
	return t(`${wizardName}.steps.${step}`, { ns: NS });
}

export function getWizardOption(wizardName: string, option: string): string {
	return t(`${wizardName}.options.${option}`, { ns: NS });
}

export function getWizardMessage(wizardName: string, message: string): string {
	return t(`${wizardName}.messages.${message}`, { ns: NS });
}

export function getModeLabel(mode: string): string {
	return t(`configureWizard.modes.${mode}`, { ns: NS });
}

export function getListPersonasCount(count: number): string {
	return t("listPersonas.count", { ns: NS, count });
}

export function getPlatformCount(platform: string, count: number): string {
	return t("listPersonas.platformCount", { ns: NS, platform, count });
}

export function getDeletePersonaMessage(message: string): string {
	return t(`deletePersonaWizard.messages.${message}`, { ns: NS });
}

export function getReviewMessage(message: string): string {
	return t(`reviewContentWizard.messages.${message}`, { ns: NS });
}

export function getReviewPrompt(prompt: string): string {
	return t(`reviewContentWizard.prompts.${prompt}`, { ns: NS });
}
