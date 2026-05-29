import * as fs from "fs";
import * as path from "path";
import type { IRuleRepository } from "./IRuleRepository.js";
import type { AssociationPattern, AssociativeRule, RuleCategory, RuleMeta, RulesData, RulesIndex } from "./types.js";
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
      const variantMap = new Map<string, { category: string; rule: AssociativeRule }>();
      const associationPatterns = data.core_rules?.association_patterns ?? [];
      const evolutionStrategies = data.core_rules?.evolution_strategies ?? [];

      for (const [categoryName, category] of Object.entries(normalizeRulesData(data))) {
        indexCategory(categoryName, category, exactBlacklist, associativeMap, variantMap);
      }

      // Phase 2: if an encrypted remote feed file exists, decrypt and merge
      const encryptedPath = this.rulesPath.replace(/\.json$/, ".encrypted");
      if (fs.existsSync(encryptedPath)) {
        const encryptedRaw = await fs.promises.readFile(encryptedPath, "utf-8");
        const decrypted = decryptFeedData(encryptedRaw, "");
        if (decrypted) {
          try {
            const remoteData: RulesData = JSON.parse(decrypted);
            for (const [catName, cat] of Object.entries(normalizeRulesData(remoteData))) {
              indexCategory(catName, cat, exactBlacklist, associativeMap, variantMap);
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
        variantMap,
        associationPatterns,
        evolutionStrategies,
        meta: {
          version: data.version ?? "1.0.0",
          last_updated: data.last_updated ?? "",
          categories: Object.keys(normalizeRulesData(data)),
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
    const exact = this.index.variantMap.get(variant);
    if (exact) return [exact];

    const normalized = normalizeConfusableVariant(variant);
    if (normalized !== variant) {
      const fuzzy = this.index.variantMap.get(normalized);
      if (fuzzy) return [fuzzy];
    }

    return [];
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

function normalizeRulesData(data: RulesData): Record<string, RuleCategory> {
  if (data.categories) return data.categories;
  if (!data.core_rules) return {};

  const patternRiskType = new Map(
    data.core_rules.association_patterns.map((p) => [p.pattern, p.risk_type])
  );
  const defaultRiskType = data.core_rules.association_patterns[0]?.risk_type ?? "网络文化误读";

  return {
    core: {
      enabled: true,
      weight: 1,
      associative_map: data.core_rules.risk_roots.map((root) => {
        const variants = expandVariants(root.word, root.variants_check);
        const riskType = root.risk_type ?? inferRiskType(root.word, patternRiskType, defaultRiskType);
        return {
          root: root.word,
          variants,
          misinterpret_direction: riskType,
          severity: riskType.includes("涉黄") ? "HIGH" : "MEDIUM",
          base_score: riskType.includes("涉黄") ? 0.85 : 0.65,
          suggestion: root.suggestion ?? "保留正常语境限定；如用于食材、花草等正常表达，补充品类说明以降低误读。",
        };
      }),
    },
  };
}

function expandVariants(root: string, modifiers: string[]): string[] {
  const variants = new Set<string>([root]);
  const suffix = root.slice(1);

  for (const modifier of modifiers) {
    if (!modifier) continue;
    variants.add(`${modifier}${root}`);
    if (suffix) variants.add(`${modifier}${suffix}`);
  }

  return [...variants];
}

function inferRiskType(
  word: string,
  patternRiskType: Map<string, string>,
  fallback: string
): string {
  if (["木耳", "菊花"].includes(word)) return "涉黄风险";
  return patternRiskType.get("食材+异常修饰") ?? fallback;
}

function indexCategory(
  categoryName: string,
  category: RuleCategory,
  exactBlacklist: Set<string>,
  associativeMap: Map<string, { category: string; rule: AssociativeRule }>,
  variantMap: Map<string, { category: string; rule: AssociativeRule }>
): void {
  if (!category.enabled) return;
  for (const rule of category.associative_map) {
    const entry = { category: categoryName, rule };
    associativeMap.set(`${categoryName}::${rule.root}`, entry);
    variantMap.set(rule.root, entry);
    exactBlacklist.add(rule.root);
    for (const variant of rule.variants) {
      exactBlacklist.add(variant);
      variantMap.set(variant, entry);
    }
  }
}

function normalizeConfusableVariant(variant: string): string {
  const confusables: Record<string, string> = {
    局: "菊",
  };

  return [...variant].map((ch) => confusables[ch] ?? ch).join("");
}
