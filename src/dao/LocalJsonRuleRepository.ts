import * as fs from "fs";
import * as path from "path";
import type { IRuleRepository } from "./IRuleRepository.js";
import type { AssociationPattern, AssociativeRule, CoreRules, RuleCategory, RuleMeta, RulesData, RulesIndex } from "./types.js";
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
  private proRulesPath: string;
  private index: RulesIndex | null = null;

  constructor(skillsDir: string) {
    this.rulesPath = path.join(skillsDir, "rules_free.json");     // 默认免费版
    this.proRulesPath = path.join(skillsDir, "rules_pro.json");   // 付费版
  }

  /**
   * 是否为付费用户（可通过配置、环境变量或 token 判断）
   */
  private isProUser(): boolean {
    // 支持多种判断方式，优先级从高到低
    if (process.env.KEVLAR_PRO_TOKEN) return true;
    if (process.env.KEVLAR_TIER === "pro") return true;
    
    // 后续可扩展：从 kevlar-config.json 读取 subscription 信息
    return false;
  }

  async loadRules(): Promise<boolean> {
    try {
      let mergedData: RulesData = { version: "0.0.0", last_updated: "", categories: {} };
      let coreRulesFromFree: CoreRules | undefined;

      // 1. 加载免费版（必须）
      if (fs.existsSync(this.rulesPath)) {
        const freeRaw = await fs.promises.readFile(this.rulesPath, "utf-8");
        const freeData: RulesData = JSON.parse(freeRaw);
        coreRulesFromFree = freeData.core_rules;
        mergedData = this.mergeRules(mergedData, freeData);
        logger.info("Free rules loaded", { event: "free_rules_loaded", version: freeData.version });
      } else {
        logger.warn("rules_free.json not found, skipped", { event: "rules_file_missing", path: this.rulesPath });
        return false;
      }

      // 2. 如果是付费用户，加载并合并 Pro 规则
      if (this.isProUser() && fs.existsSync(this.proRulesPath)) {
        const proRaw = await fs.promises.readFile(this.proRulesPath, "utf-8");
        const proData: RulesData = JSON.parse(proRaw);
        mergedData = this.mergeRules(mergedData, proData, true); // true = pro 优先
        logger.info("Pro rules merged for paid user", { event: "pro_rules_merged", version: proData.version });
      }

      // Phase 2: if an encrypted remote feed file exists, decrypt and merge
      const encryptedPath = this.rulesPath.replace(/\.json$/, ".encrypted");
      if (fs.existsSync(encryptedPath)) {
        const encryptedRaw = await fs.promises.readFile(encryptedPath, "utf-8");
        const decrypted = decryptFeedData(encryptedRaw, "");
        if (decrypted) {
          try {
            const remoteData: RulesData = JSON.parse(decrypted);
            mergedData = this.mergeRules(mergedData, remoteData, true); // Remote 也优先
            logger.info("Rules enriched from remote feed", { event: "rules_remote_merged" });
          } catch {
            logger.warn("Failed to parse decrypted remote rules", { event: "rules_remote_parse_error" });
          }
        }
      }

      // 后续索引构建逻辑
      const exactBlacklist = new Set<string>();
      const associativeMap = new Map<string, { category: string; rule: AssociativeRule }>();
      const variantMap = new Map<string, { category: string; rule: AssociativeRule }>();

      // 从原始数据中获取 associationPatterns 和 evolutionStrategies
      // 优先使用 freeData 中的 core_rules，如果没有则使用合并后的数据
      const coreRules = coreRulesFromFree || mergedData.core_rules;
      const associationPatterns = coreRules?.association_patterns ?? [];
      const evolutionStrategies = coreRules?.evolution_strategies ?? [];

      for (const [categoryName, category] of Object.entries(normalizeRulesData(mergedData))) {
        indexCategory(categoryName, category, exactBlacklist, associativeMap, variantMap);
      }

      this.index = {
        exactBlacklist,
        associativeMap,
        variantMap,
        associationPatterns,
        evolutionStrategies,
        meta: {
          version: mergedData.version ?? "2.1.0",
          last_updated: mergedData.last_updated ?? "",
          categories: Object.keys(normalizeRulesData(mergedData)),
        },
        loadedAt: Date.now(),
      };

      logger.info("Rules loaded successfully", {
        event: "rules_loaded",
        tier: this.isProUser() ? "pro" : "free",
        version: mergedData.version,
        blacklistSize: exactBlacklist.size,
        associativeSize: associativeMap.size,
      });

      return true;
    } catch (err) {
      logger.error("Failed to load rules", { event: "rules_load_error", error: String(err) });
      return false;
    }
  }

  /**
   * 合并规则（Pro 规则可覆盖 Free）
   */
  private mergeRules(base: RulesData, additional: RulesData, proPriority: boolean = false): RulesData {
    const result: RulesData = { ...base };

    // 将 additional 规范化为 categories 格式
    const normalizedAdditional = normalizeRulesData(additional);
    if (Object.keys(normalizedAdditional).length === 0) return result;
    
    if (!result.categories) result.categories = {};

    for (const [catName, catData] of Object.entries(normalizedAdditional)) {
      if (!result.categories[catName]) {
        // 新分类，直接添加
        result.categories[catName] = { ...catData };
      } else {
        // 合并 rules 数组，Pro 优先（去重 + 覆盖）
        const existing = result.categories[catName].associative_map || [];
        const newRules = catData.associative_map || [];

        const ruleMap = new Map(existing.map(r => [r.root, r]));

        for (const rule of newRules) {
          ruleMap.set(rule.root, rule); // Pro 覆盖同 root 的规则
        }

        result.categories[catName].associative_map = Array.from(ruleMap.values());
        result.categories[catName].enabled = catData.enabled ?? result.categories[catName].enabled;
        result.categories[catName].weight = catData.weight ?? result.categories[catName].weight;
      }
    }

    // 合并 multi_hop_patterns（如果存在）
    for (const [catName, catData] of Object.entries(normalizedAdditional)) {
      if (catData.multi_hop_patterns && result.categories[catName]) {
        const existingPatterns = result.categories[catName].multi_hop_patterns || [];
        const newPatterns = catData.multi_hop_patterns;
        
        // 按 pattern 字符串去重，新的优先
        const patternMap = new Map(existingPatterns.map(p => [JSON.stringify(p.pattern), p]));
        for (const pattern of newPatterns) {
          patternMap.set(JSON.stringify(pattern.pattern), pattern);
        }
        result.categories[catName].multi_hop_patterns = Array.from(patternMap.values());
      }
    }

    // 更新版本信息（取较高版本）
    if (additional.version && (!result.version || additional.version > result.version)) {
      result.version = additional.version;
    }
    if (additional.last_updated && (!result.last_updated || additional.last_updated > result.last_updated)) {
      result.last_updated = additional.last_updated;
    }

    return result;
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
  // 如果已经是新的 categories 格式（包含 associative_map），直接返回
  if (data.categories) {
    // 检查是否需要将旧格式的 rules 转换为 associative_map
    const normalizedCategories: Record<string, RuleCategory> = {};
    
    for (const [catName, catData] of Object.entries(data.categories)) {
      if (catData.associative_map && catData.associative_map.length > 0) {
        // 已经是新格式
        normalizedCategories[catName] = catData;
      } else if (catData.rules && catData.rules.length > 0) {
        // 旧格式（rules 数组），需要转换
        normalizedCategories[catName] = {
          enabled: true,
          weight: 1,
          associative_map: catData.rules.map((rule: any) => ({
            root: rule.root,
            variants: rule.variants || [],
            misinterpret_direction: rule.risk || rule.type || "未知风险",
            severity: rule.type?.includes("涉黄") ? "HIGH" : "MEDIUM",
            base_score: rule.type?.includes("涉黄") ? 0.85 : 0.65,
            suggestion: rule.suggestion ?? "保留正常语境限定；如用于食材、花草等正常表达，补充品类说明以降低误读。",
          })),
          multi_hop_patterns: catData.multi_hop_patterns,
          name: catData.name,
          severity: catData.severity,
        };
      } else {
        // 空分类，保留基本结构
        normalizedCategories[catName] = {
          enabled: true,
          weight: 1,
          associative_map: [],
          name: catData.name,
          severity: catData.severity,
        };
      }
    }
    
    return normalizedCategories;
  }

  // 旧格式：core_rules
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
  if (!category.associative_map) return;
  
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
