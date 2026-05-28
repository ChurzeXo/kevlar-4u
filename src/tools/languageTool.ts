import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../utils/types.js";
import type { ToolModule } from "./types.js";
import { getCurrentLanguage, changeLanguage, type SupportedLanguage } from "../i18n/index.js";
import { getToolDescription } from "../i18n/tools-i18n.js";

export const languageToolDefinition: Tool = {
  name: "set_language",
  description: getToolDescription("setLanguage"),
  inputSchema: {
    type: "object" as const,
    properties: {
      language: {
        type: "string",
        description: "Language code: 'zh-CN' for Chinese, 'en-US' for English",
        enum: ["zh-CN", "en-US"],
      },
    },
    required: ["language"],
  },
};

export const languageModule: ToolModule = {
  definition: languageToolDefinition,
  handler: () => async (args) => {
    const language = args?.language as string;
    return await handleSetLanguage(language);
  },
};

export async function handleSetLanguage(language: string): Promise<ToolResult> {
  if (!language || !["zh-CN", "en-US"].includes(language)) {
    return {
      content: [{
        type: "text",
        text: "❌ Invalid language. Supported: 'zh-CN' (Chinese) or 'en-US' (English)",
      }],
      isError: true,
    };
  }

  const previousLang = getCurrentLanguage();
  const newLang = language as SupportedLanguage;
  
  await changeLanguage(newLang);

  const locale = getCurrentLanguage();
  if (locale === "zh-CN") {
    return {
      content: [{
        type: "text",
        text: `✅ 语言已切换为：简体中文 (zh-CN)\n\n之前语言：${previousLang === "zh-CN" ? "简体中文" : "English"}`,
      }],
    };
  }

  return {
    content: [{
      type: "text",
      text: `✅ Language switched to: English (en-US)\n\nPrevious language: ${previousLang === "zh-CN" ? "简体中文" : "English"}`,
    }],
  };
}
