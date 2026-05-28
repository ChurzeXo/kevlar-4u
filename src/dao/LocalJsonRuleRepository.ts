import * as fs from "fs";
import * as path from "path";
import type { IRuleRepository } from "./IRuleRepository.js";
import type { AssociativeRule, RuleMeta, RulesData, RulesIndex } from "./types.js";
import { logger } from "../utils/observability.js";

/**
 * Phase 2 stub: decrypt feed data payload received from the cloud sync server.
 * Returns plaintext JSON string (or empty string on failure).
 * In Phase 1 (local-only), this is a no-op that logs and returns empty.
 */
export function decryptFeedData(cipherText: string, _token: string): string {
  if (!cipherText) return "";
  logger.info("Phase 2 stub: decryptFeedData called (no-op in Phase 1)", {
    event: "phase2_stub_decrypt",
    cipherLength: cipherText.length,
  });
  return "";
}

export class LocalJsonRuleRepository implements IRuleRepository {
  private rulesPath: string;
  private index: RulesIndex | null = null;

  constructor(skillsDir: string) {
    this.rulesPath = path.join(skillsDir, "rules.json");
  }

  async loadRules(): Promise<boolean> {
    try {
      if (!fs.existsSync(this.rulesPath)) {
        logger.warn("rules.json not found, skipped", { event: "rules_file_missing", path: this.rulesPath });
        return false;
      }

      const raw = await fs.promises.readFile(this.rulesPath, "utf-8");
      const data: RulesData = JSON.parse(raw);

      const exactBlacklist = new Set<string>();
      const associativeMap = new Map<string, { category: string; rule: AssociativeRule }>();

      for (const [categoryName, category] of Object.entries(data.categories)) {
        if (!category.enabled) continue;
        for (const rule of category.associative_map) {
          associativeMap.set(`${categoryName}::${rule.root}`, { category: categoryName, rule });
          for (const variant of rule.variants) {
            exactBlacklist.add(variant);
          }
          exactBlacklist.add(rule.root);
        }
      }

      // Phase 2: if an encrypted remote feed file exists, decrypt and merge
      const encryptedPath = this.rulesPath.replace(/\.json$/, ".encrypted");
      if (fs.existsSync(encryptedPath)) {
        const encryptedRaw = await fs.promises.readFile(encryptedPath, "utf-8");
        const decrypted = decryptFeedData(encryptedRaw, "");
        if (decrypted) {
          try {
            const remoteData: RulesData = JSON.parse(decrypted);
            for (const [catName, cat] of Object.entries(remoteData.categories)) {
              if (!cat.enabled) continue;
              for (const rule of cat.associative_map) {
                associativeMap.set(`${catName}::${rule.root}`, { category: catName, rule });
                for (const variant of rule.variants) exactBlacklist.add(variant);
                exactBlacklist.add(rule.root);
              }
            }
            logger.info("Rules enriched from remote feed", { event: "rules_remote_merged" });
          } catch {
            logger.warn("Failed to parse decrypted remote rules", { event: "rules_remote_parse_error" });
          }
        }
      }

      this.index = {
        exactBlacklist,
        associativeMap,
        meta: {
          version: data.version,
          last_updated: data.last_updated,
          categories: Object.keys(data.categories),
        },
        loadedAt: Date.now(),
      };

      logger.info("Rules loaded", {
        event: "rules_loaded",
        version: data.version,
        blacklistSize: exactBlacklist.size,
        associativeSize: associativeMap.size,
      });

      return true;
    } catch (err) {
      logger.error("Failed to load rules", { event: "rules_load_error", error: String(err) });
      return false;
    }
  }

  async getRuleByRoot(category: string, root: string): Promise<AssociativeRule | null> {
    if (!this.index) await this.loadRules();
    if (!this.index) return null;
    const entry = this.index.associativeMap.get(`${category}::${root}`);
    return entry?.rule ?? null;
  }

  isBlacklisted(variant: string): boolean {
    if (!this.index) return false;
    return this.index.exactBlacklist.has(variant);
  }

  resolveVariant(variant: string): Array<{ category: string; rule: AssociativeRule }> {
    if (!this.index) return [];
    const results: Array<{ category: string; rule: AssociativeRule }> = [];
    for (const [, entry] of this.index.associativeMap) {
      if (entry.rule.variants.includes(variant) || entry.rule.root === variant) {
        results.push(entry);
      }
    }
    return results;
  }

  async getMeta(): Promise<RuleMeta> {
    if (!this.index) await this.loadRules();
    if (!this.index) return { version: "0.0.0", last_updated: "", categories: [] };
    return this.index.meta;
  }

  getIndex(): RulesIndex | null {
    return this.index;
  }

  /**
   * Phase 2 stub: no-op in Phase 1.
   * Will be implemented when RemoteSubscriptionRuleRepository is introduced.
   */
  async injectDecryptedStream(_cipherText: string, _token: string): Promise<boolean> {
    logger.info("Phase 2 stub: injectDecryptedStream called (no-op in Phase 1)", {
      event: "phase2_stub_inject",
    });
    return false;
  }
}
