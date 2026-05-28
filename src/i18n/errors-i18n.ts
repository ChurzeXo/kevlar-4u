import { t } from "./index.js";

const NS = "errors";

export function getErrorMessageByKey(category: string, key: string): string {
	return t(`${category}.${key}`, { ns: NS });
}

export function getCommonError(key: string): string {
	return t(`common.${key}`, { ns: NS });
}

export function getToolError(key: string): string {
	return t(`tool.${key}`, { ns: NS });
}

export function getPersonaError(key: string): string {
	return t(`persona.${key}`, { ns: NS });
}

export function getReviewError(key: string): string {
	return t(`review.${key}`, { ns: NS });
}

export function getConfigError(key: string): string {
	return t(`config.${key}`, { ns: NS });
}

export function getWizardError(key: string): string {
	return t(`wizard.${key}`, { ns: NS });
}

export function getMcpError(key: string): string {
	return t(`mcp.${key}`, { ns: NS });
}

export function formatLocalizedError(category: string, key: string, details?: string): string {
	const baseMessage = getErrorMessageByKey(category, key);
	if (details) {
		return `${baseMessage}: ${details}`;
	}
	return baseMessage;
}
