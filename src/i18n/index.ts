import i18next from "i18next";
import Backend from "i18next-fs-backend";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type SupportedLanguage = "zh-CN" | "en-US";

const SUPPORTED_LANGUAGES: SupportedLanguage[] = ["zh-CN", "en-US"];

function detectLanguage(): SupportedLanguage {
	const envLang = process.env.KUVLAR_LANG?.trim();
	if (envLang && SUPPORTED_LANGUAGES.includes(envLang as SupportedLanguage)) {
		return envLang as SupportedLanguage;
	}
	return "zh-CN";
}

let initialized = false;

export async function initI18n(lang?: SupportedLanguage): Promise<void> {
	if (initialized) return;

	const detectedLang = lang || detectLanguage();

	await i18next.use(Backend).init({
		lng: detectedLang,
		fallbackLng: "zh-CN",
		supportedLngs: SUPPORTED_LANGUAGES,
		ns: ["common", "tools", "wizard", "dimensions", "errors"],
		defaultNS: "common",
		backend: {
			loadPath: join(__dirname, "locales", "{{lng}}", "{{ns}}.json"),
		},
		interpolation: {
			escapeValue: false,
		},
	});

	initialized = true;
}

export function t(
	key: string,
	options?: { ns?: string; defaultValue?: string; [key: string]: unknown },
): string {
	return i18next.t(key, options) as string;
}

export function getCurrentLanguage(): SupportedLanguage {
	return (i18next.language || "zh-CN") as SupportedLanguage;
}

export async function changeLanguage(lang: SupportedLanguage): Promise<void> {
	if (!SUPPORTED_LANGUAGES.includes(lang)) {
		throw new Error(`Unsupported language: ${lang}`);
	}
	if (!initialized) {
		await initI18n(lang);
	} else {
		await i18next.changeLanguage(lang);
	}
}

export { i18next };

// Re-export adapters (avoid name conflicts)
export {
	getDimensionLabel,
	getDimensionDescription,
	getDimensionSentinelPoints,
	getDimensionCriteria,
	getLocalizedDimension,
	getLocalizedDimensions,
	getDefensiveUITitle,
	getOffensiveUITitle,
	getDefensiveMandatoryLabel,
	getOffensiveOptionalLabel,
	getStancePresetLabel,
	getStancePerspective,
} from "./dimensions-i18n.js";

export {
	getToolDescription,
	getToolTitle,
	getHelpText,
	getWizardPrompt,
	getWizardStep,
	getWizardOption,
	getWizardMessage,
	getModeLabel,
	getListPersonasCount,
	getPlatformCount,
	getDeletePersonaMessage,
	getReviewMessage,
	getReviewPrompt,
} from "./tools-i18n.js";

export {
	getErrorMessageByKey,
	getCommonError,
	getToolError,
	getPersonaError,
	getReviewError,
	getConfigError,
	getWizardError,
	getMcpError,
	formatLocalizedError,
} from "./errors-i18n.js";

export {
	getWizardCommon,
	getWizardGoBack,
	getPlatformOption,
	getAgeRangeOption,
	getGenderOption,
	getInterestOption,
	getToneOption,
	getAuthorRelationOption,
	getPerspectiveOption,
	getPlatformPrompt,
	getAgeRangePrompt,
	getGenderPrompt,
	getInterestsPrompt,
	getTonePrompt,
	getAuthorRelationPrompt,
	getPerspectivePrompt,
	getDimensionsPrompt,
	getDimensionsDefensiveLabel,
	getDimensionsOffensiveLabel,
	getNamePrompt,
	getConfirmPrompt,
	getConfirmPreview,
	getReviewContentInput,
	getReviewPlatformNote,
	getConfigureSelectMode,
	getConfigureSetConcurrency,
	getConfigureConfirmChanges,
	getDeleteSelectPersona,
	getDeleteConfirmDelete,
	getDeleteMessage,
	getWizardError as getWizardErrorMessage,
} from "./wizard-i18n.js";
