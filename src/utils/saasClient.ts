import type { PromptSegments } from "../subscription/promptTypes.js";
import { readConfig } from "../execution/config.js";
import { getCurrentLanguage } from "../i18n/index.js";
import { logger } from "./observability.js";

let cachedPrompts: PromptSegments | null = null;
let lastFetchUrl = "";

export class SaaSClient {
  static async fetchSubscriptionPrompts(): Promise<PromptSegments | null> {
    const config = readConfig();
    if (!config.sync_token || !config.cloud_server_url) return null;

    const locale = getCurrentLanguage();
    const baseUrl = config.cloud_server_url.replace(/\/+$/, "");
    const url = `${baseUrl}/api/v1/subscription-prompts?locale=${locale}`;

    if (cachedPrompts && lastFetchUrl === url) {
      return cachedPrompts;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.sync_token}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        logger.warn("SaaS server returned non-OK status", {
          event: "saas_fetch_failed",
          status: response.status,
        });
        return null;
      }

      const data = await response.json();
      if (!data || !data.prompts) return null;

      cachedPrompts = data.prompts as PromptSegments;
      lastFetchUrl = url;
      return cachedPrompts;
    } catch (err) {
      logger.warn("Failed to fetch subscription prompts, falling back to Free tier", {
        event: "saas_fetch_error",
        error: (err as Error).message,
      });
      return null;
    }
  }

  static clearCache(): void {
    cachedPrompts = null;
    lastFetchUrl = "";
  }
}
