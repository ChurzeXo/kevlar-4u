import * as fs from "fs";
import * as path from "path";
import type { IRuleRepository } from "./IRuleRepository.js";
import type {
  AssociationPattern,
  AssociativeRule,
  CoreRules,
  RuleCategory,
  RuleMeta,
  RulesData,
  RulesIndex,
  SensitiveWindow,
  StructuralMatch,
  StructuralPattern,
  TimingFinding,
} from "./types.js";
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

const BUILTIN_SENSITIVE_WINDOWS: SensitiveWindow[] = [
  {
    id: "womens_day",
    label: "妇女节",
    month: 3,
    day: 8,
    windowDays: 7,
    riskMultiplier: 2.0,
    relevanceKeywords: ["女性", "女人", "妈妈", "姐妹", "她", "女生", "美妆", "护肤", "身材", "减肥", "婚姻", "职场"],
    forceKeywords: ["女权", "性别", "物化", "歧视"],
  },
  {
    id: "childrens_day",
    label: "儿童节",
    month: 6,
    day: 1,
    windowDays: 7,
    riskMultiplier: 2.5,
    relevanceKeywords: ["孩子", "儿童", "小朋友", "亲子", "教育", "玩具", "童装", "未成年"],
    forceKeywords: ["恋童", "幼", "侵犯"],
  },
  {
    id: "valentines_day",
    label: "情人节",
    month: 2,
    day: 14,
    windowDays: 5,
    riskMultiplier: 1.8,
    relevanceKeywords: ["恋爱", "约会", "礼物", "浪漫", "情侣", "单身", "表白", "前任"],
    forceKeywords: ["出轨", "约炮", "419"],
  },
  {
    id: "labour_day",
    label: "劳动节",
    month: 5,
    day: 1,
    windowDays: 3,
    riskMultiplier: 1.3,
    relevanceKeywords: ["打工人", "加班", "996", "劳动", "薪资", "休假", "职场"],
    forceKeywords: ["剥削", "压榨"],
  },
  {
    id: "programmers_day",
    label: "程序员节",
    month: 10,
    day: 24,
    windowDays: 3,
    riskMultiplier: 1.5,
    relevanceKeywords: ["程序员", "代码", "程序", "IT", "技术", "编程"],
    forceKeywords: [],
  },
  {
    id: "singles_day",
    label: "光棍节",
    month: 11,
    day: 11,
    windowDays: 3,
    riskMultiplier: 1.5,
    relevanceKeywords: ["单身", "购物", "消费", "打折", "双十一", "折扣"],
    forceKeywords: [],
  },
];

export class LocalJsonRuleRepository implements IRuleRepository {
  private skillsDir: string;
  private rulesPath: string;
  private proRulesPath: string;
  private index: RulesIndex | null = null;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    this.rulesPath = path.join(skillsDir, "rules_free.json");
    this.proRulesPath = path.join(skillsDir, "rules_pro.json");
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
      // ── 1. 加载现有 rules_free.json 和 rules_pro.json ──────────────────
      let mergedData: RulesData = { version: "0.0.0", last_updated: "", categories: {} };
      let coreRulesFromFree: CoreRules | undefined;

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

      if (this.isProUser() && fs.existsSync(this.proRulesPath)) {
        const proRaw = await fs.promises.readFile(this.proRulesPath, "utf-8");
        const proData: RulesData = JSON.parse(proRaw);
        mergedData = this.mergeRules(mergedData, proData, true);
        logger.info("Pro rules merged for paid user", { event: "pro_rules_merged", version: proData.version });
      }

      const encryptedPath = this.rulesPath.replace(/\.json$/, ".encrypted");
      if (fs.existsSync(encryptedPath)) {
        const encryptedRaw = await fs.promises.readFile(encryptedPath, "utf-8");
        const decrypted = decryptFeedData(encryptedRaw, "");
        if (decrypted) {
          try {
            const remoteData: RulesData = JSON.parse(decrypted);
            mergedData = this.mergeRules(mergedData, remoteData, true);
            logger.info("Rules enriched from remote feed", { event: "rules_remote_merged" });
          } catch {
            logger.warn("Failed to parse decrypted remote rules", { event: "rules_remote_parse_error" });
          }
        }
      }

      // ── 2. 加载 rules_lowbrow.json（独立 schema，不混入 categories） ───
      const lowbrowPath = path.join(this.skillsDir, "rules_lowbrow.json");
      let semanticPrimesData: Record<string, string[]> = {};
      let structuralPatternsData: StructuralPattern[] = [];

      if (fs.existsSync(lowbrowPath)) {
        const lowbrowRaw = await fs.promises.readFile(lowbrowPath, "utf-8");
        const lowbrowData = JSON.parse(lowbrowRaw);
        if (lowbrowData.semantic_primes) {
          semanticPrimesData = Object.fromEntries(
            Object.entries(lowbrowData.semantic_primes).map(
              ([k, v]: [string, any]) => [k, v.words ?? []]
            )
          );
        }
        structuralPatternsData = lowbrowData.structural_patterns ?? [];
        logger.info("Lowbrow rules loaded", {
          event: "lowbrow_rules_loaded",
          primeCategories: Object.keys(semanticPrimesData).length,
          structuralPatterns: structuralPatternsData.length,
        });
      }

      // ── 3. 加载 rules_sensitive.json（复用 categories 格式） ────────────
      const sensitivePath = path.join(this.skillsDir, "rules_sensitive.json");
      if (fs.existsSync(sensitivePath)) {
        const sensitiveRaw = await fs.promises.readFile(sensitivePath, "utf-8");
        const sensitiveData: RulesData = JSON.parse(sensitiveRaw);
        mergedData = this.mergeRules(mergedData, sensitiveData);
        logger.info("Sensitive rules loaded", { event: "sensitive_rules_loaded" });
      }

      // ── 4. 构建索引 ─────────────────────────────────────────────────────
      const exactBlacklist = new Set<string>();
      const associativeMap = new Map<string, { category: string; rule: AssociativeRule }>();
      const variantMap = new Map<string, { category: string; rule: AssociativeRule }>();
      const multiHopPatterns = new Map<string, Array<{ pattern: string[]; risk: string }>>();

      const coreRules = coreRulesFromFree || mergedData.core_rules;
      const associationPatterns = coreRules?.association_patterns ?? [];
      const evolutionStrategies = coreRules?.evolution_strategies ?? [];

      for (const [categoryName, category] of Object.entries(normalizeRulesData(mergedData))) {
        indexCategory(categoryName, category, exactBlacklist, associativeMap, variantMap);
        // 索引 multi_hop_patterns
        if (category.multi_hop_patterns) {
          multiHopPatterns.set(categoryName, category.multi_hop_patterns);
        }
      }

      this.index = {
        exactBlacklist,
        associativeMap,
        variantMap,
        associationPatterns,
        evolutionStrategies,
        semanticPrimes: new Map(Object.entries(semanticPrimesData)),
        structuralPatterns: structuralPatternsData,
        multiHopPatterns,
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
        structuralPatterns: structuralPatternsData.length,
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

  // ── Phase 0.1 时机节点检测 ────────────────────────────────────────────

  checkTimingRisk(date: Date, content: string): TimingFinding | null {
    for (const window of BUILTIN_SENSITIVE_WINDOWS) {
      const windowDate = new Date(date.getFullYear(), window.month - 1, window.day);
      const diffMs = date.getTime() - windowDate.getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      const absDiff = Math.abs(diffDays);

      if (absDiff > window.windowDays) continue;

      // 第一层：本地规则层——内容必须命中关联词
      const hasForceKeyword = window.forceKeywords.length > 0
        ? window.forceKeywords.some((kw) => content.includes(kw))
        : false;
      const hasRelevanceKeyword = window.relevanceKeywords.some((kw) => content.includes(kw));

      if (!hasForceKeyword && !hasRelevanceKeyword) continue;

      return {
        type: 'timing_risk',
        windowId: window.id,
        windowLabel: window.label,
        daysFromCenter: diffDays,
        riskMultiplier: window.riskMultiplier,
        matched: true,
        description: `当前日期处于【${window.label}窗口期】（距中心日 ${absDiff} 天），内容涉及关联主题词，建议关注舆论语境下的风险放大效应。`,
      };
    }

    return null;
  }

  // ── Multi-hop patterns 检测 ─────────────────────────────────────────────

  checkMultiHopPatterns(content: string): Array<{ pattern: string[]; risk: string; category: string; matchedWords: string[] }> {
    if (!this.index) return [];
    const { multiHopPatterns } = this.index;
    if (multiHopPatterns.size === 0) return [];

    const results: Array<{ pattern: string[]; risk: string; category: string; matchedWords: string[] }> = [];

    for (const [category, patterns] of multiHopPatterns) {
      for (const pattern of patterns) {
        const matchedWords: string[] = [];
        let allMatched = true;

        for (const word of pattern.pattern) {
          if (content.includes(word)) {
            matchedWords.push(word);
          } else {
            allMatched = false;
            break;
          }
        }

        if (allMatched && matchedWords.length > 0) {
          results.push({
            pattern: pattern.pattern,
            risk: pattern.risk,
            category,
            matchedWords,
          });
        }
      }
    }

    return results;
  }

  // ── L2 结构模式检测 ─────────────────────────────────────────────────────

  checkStructuralPatterns(content: string): StructuralMatch[] {
    if (!this.index) return [];
    const { semanticPrimes, structuralPatterns } = this.index;
    if (structuralPatterns.length === 0 || semanticPrimes.size === 0) return [];

    const results: StructuralMatch[] = [];

    for (const pattern of structuralPatterns) {
      // ── 分两种模式处理 ──────────────────────────────────────────────

      if (pattern.minCategoryCount !== undefined) {
        // 密度模式：计算窗口内满足至少 N 个不同类别
        const densityMatches = this.matchByDensity(content, pattern, semanticPrimes);
        if (densityMatches) results.push(densityMatches);
      } else if (pattern.requiredCategories && pattern.requiredCategories.length > 0) {
        // 精确类别模式：所有 requiredCategories 必须同时命中
        const categoryMatches = this.matchByRequiredCategories(content, pattern, semanticPrimes);
        if (categoryMatches) results.push(categoryMatches);
      }
    }

    return results;
  }

  // ── 精确类别模式 ──────────────────────────────────────────────────────

  private matchByRequiredCategories(
    content: string,
    pattern: StructuralPattern,
    semanticPrimes: Map<string, string[]>,
  ): StructuralMatch | null {
    const categoryHits: Array<{ word: string; position: number }>[] = [];

    for (const catId of pattern.requiredCategories!) {
      const words = semanticPrimes.get(catId);
      if (!words || words.length === 0) return null;
      const hits = findWordsInContent(content, words);
      if (hits.length === 0) return null;
      categoryHits.push(hits);
    }

    // 最小跨度窗口
    let minRange = Infinity;
    let bestMinPos = 0;
    let bestMaxPos = 0;
    let bestWords: Array<{ category: string; word: string; position: number }> = [];

    function walk(idx: number, selected: Array<{ category: string; word: string; position: number }>) {
      if (idx === categoryHits.length) {
        const positions = selected.map((h) => h.position);
        const range = Math.max(...positions) - Math.min(...positions);
        if (range < minRange) {
          minRange = range;
          bestMinPos = Math.min(...positions);
          bestMaxPos = Math.max(...positions);
          bestWords = [...selected];
        }
        return;
      }
      for (const hit of categoryHits[idx]) {
        walk(idx + 1, [...selected, { ...hit, category: pattern.requiredCategories![idx] }]);
      }
    }

    const cappedHits = categoryHits.map((hits) =>
      hits.length > 5 ? hits.slice(0, 5) : hits,
    );
    walk(0, []);

    if (minRange > pattern.windowSize) return null;

    return {
      patternId: pattern.id,
      riskType: pattern.risk_type,
      severity: pattern.severity,
      matchedWords: bestWords,
      windowStart: bestMinPos,
      windowEnd: bestMaxPos,
      suggestedLevel: pattern.auto_red ? "🔴" : "🟡",
    };
  }

  // ── 密度模式：命中至少 N 个不同类别 ──────────────────────────────────

  private matchByDensity(
    content: string,
    pattern: StructuralPattern,
    semanticPrimes: Map<string, string[]>,
  ): StructuralMatch | null {
    const threshold = pattern.minCategoryCount!;
    const windowSize = pattern.windowSize;

    // 对每个类别找所有命中位置
    const categoryRanges: Array<{ catId: string; hits: Array<{ word: string; position: number }> }> = [];

    for (const [catId, words] of semanticPrimes) {
      const hits = findWordsInContent(content, words);
      if (hits.length > 0) {
        categoryRanges.push({ catId, hits });
      }
    }

    if (categoryRanges.length < threshold) return null;

    // 找到最小窗口内能涵盖最大类别数的位置
    // 策略：滑动窗口扫描所有命中位置
    // 提取所有命中位置作为事件点
    type EventPoint = {
      pos: number;
      catId: string;
      word: string;
      isStart: boolean;
    };

    const events: EventPoint[] = [];
    for (const { catId, hits } of categoryRanges) {
      for (const hit of hits) {
        events.push({ pos: hit.position, catId, word: hit.word, isStart: true });
      }
    }
    events.sort((a, b) => a.pos - b.pos);

    // 滑动窗口
    let bestCatCount = 0;
    let bestStart = 0;
    let bestEnd = 0;
    let bestWords: Array<{ category: string; word: string; position: number }> = [];

    for (let i = 0; i < events.length; i++) {
      const windowEnd = events[i].pos + windowSize;
      const catSet = new Set<string>();
      const windowWords: Array<{ category: string; word: string; position: number }> = [];

      for (let j = i; j < events.length && events[j].pos <= windowEnd; j++) {
        catSet.add(events[j].catId);
        windowWords.push({ category: events[j].catId, word: events[j].word, position: events[j].pos });
      }

      if (catSet.size > bestCatCount || (catSet.size === bestCatCount && (events[bestStart]?.pos ?? 0) > events[i].pos)) {
        bestCatCount = catSet.size;
        bestStart = i;
        bestEnd = events[i].pos + windowSize;
        bestWords = windowWords;
      }
    }

    if (bestCatCount < threshold) return null;

    const hitCount = bestCatCount;

    return {
      patternId: pattern.id,
      riskType: pattern.risk_type,
      severity: pattern.severity,
      matchedWords: bestWords,
      windowStart: events[bestStart]?.pos ?? 0,
      windowEnd: bestEnd,
      suggestedLevel: pattern.auto_red ? "🔴" : hitCount >= threshold + 1 ? "🔴" : "🟡",
      hitCount,
      totalCategories: semanticPrimes.size,
    };
  }
}

// ── 辅助函数：在文本中查找一组词的所有位置 ──────────────────────────────

function findWordsInContent(content: string, words: string[]): Array<{ word: string; position: number }> {
  const results: Array<{ word: string; position: number }> = [];
  const seen = new Set<string>();
  for (const word of words) {
    if (seen.has(word)) continue;
    seen.add(word);
    let startIndex = 0;
    while (startIndex < content.length) {
      const pos = content.indexOf(word, startIndex);
      if (pos < 0) break;
      results.push({ word, position: pos });
      startIndex = pos + 1;
    }
  }
  return results;
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
