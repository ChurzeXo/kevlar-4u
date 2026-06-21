import * as fs from "fs";
import * as path from "path";
import type { IRuleRepository } from "./IRuleRepository.js";
import type {
  AssociativeRule,
  RuleCategory,
  RuleMeta,
  RulesIndex,
  SensitiveWindow,
  StructuralMatch,
  StructuralPattern,
  TimingFinding,
} from "./types.js";
import { logger } from "../utils/observability.js";

/**
 * Decrypt and parse the cached strategy bundle.
 * Returns the parsed bundle object, or null if unavailable/invalid.
 */
async function loadStrategyBundle(skillsDir: string): Promise<any | null> {
  const bundlePath = path.join(skillsDir, "strategy-bundle-cache.enc");
  if (!fs.existsSync(bundlePath)) return null;
  try {
    const raw = await fs.promises.readFile(bundlePath, "utf-8");
    const trimmed = raw.trim();

    // Try encrypted format (AES-256-GCM from --sync)
    if (trimmed.startsWith("kevlar:")) {
      try {
        const { deobfuscate } = await import("../pro/src/credential/index.js");
        const decoded = deobfuscate(trimmed);
        if (decoded) return JSON.parse(decoded);
      } catch { /* fall through to plain JSON */ }
    }

    // Plain JSON (dev/test fallback)
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

interface BundleRules {
  categories?: Record<string, RuleCategory>;
  semantic_primes?: Record<string, string[]>;
  structural_patterns?: StructuralPattern[];
  version?: string;
  last_updated?: string;
}

const BUILTIN_SENSITIVE_WINDOWS: SensitiveWindow[] = [
  {
    id: "womens_day", label: "妇女节", month: 3, day: 8, windowDays: 7, riskMultiplier: 2.0,
    relevanceKeywords: ["女性", "女人", "妈妈", "姐妹", "她", "女生", "美妆", "护肤", "身材", "减肥", "婚姻", "职场"],
    forceKeywords: ["女权", "性别", "物化", "歧视"],
  },
  {
    id: "childrens_day", label: "儿童节", month: 6, day: 1, windowDays: 7, riskMultiplier: 2.5,
    relevanceKeywords: ["孩子", "儿童", "小朋友", "亲子", "教育", "玩具", "童装", "未成年"],
    forceKeywords: ["恋童", "幼", "侵犯"],
  },
  {
    id: "valentines_day", label: "情人节", month: 2, day: 14, windowDays: 5, riskMultiplier: 1.8,
    relevanceKeywords: ["恋爱", "约会", "礼物", "浪漫", "情侣", "单身", "表白", "前任"],
    forceKeywords: ["出轨", "约炮", "419"],
  },
  {
    id: "labour_day", label: "劳动节", month: 5, day: 1, windowDays: 3, riskMultiplier: 1.3,
    relevanceKeywords: ["打工人", "加班", "996", "劳动", "薪资", "休假", "职场"],
    forceKeywords: ["剥削", "压榨"],
  },
  {
    id: "programmers_day", label: "程序员节", month: 10, day: 24, windowDays: 3, riskMultiplier: 1.5,
    relevanceKeywords: ["程序员", "代码", "程序", "IT", "技术", "编程"],
    forceKeywords: [],
  },
  {
    id: "singles_day", label: "光棍节", month: 11, day: 11, windowDays: 3, riskMultiplier: 1.5,
    relevanceKeywords: ["单身", "购物", "消费", "打折", "双十一", "折扣"],
    forceKeywords: [],
  },
];

export class RuleRepository implements IRuleRepository {
  private skillsDir: string;
  private index: RulesIndex | null = null;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  async loadRules(customBundle?: any): Promise<boolean> {
    try {
      // ── 1. Try loading rules from cached strategy bundle ─────────────────
      const bundle = customBundle ?? await loadStrategyBundle(this.skillsDir);

      let categories: Record<string, RuleCategory> = {};
      let semanticPrimesData: Record<string, string[]> = {};
      let structuralPatternsData: StructuralPattern[] = [];
      let version = "0.0.0";
      let lastUpdated = "";

      if (bundle?.rules) {
        const r: BundleRules = bundle.rules;
        categories = r.categories ?? {};
        semanticPrimesData = r.semantic_primes ?? {};
        structuralPatternsData = r.structural_patterns ?? [];
        version = r.version ?? "0.0.0";
        lastUpdated = r.last_updated ?? "";
        logger.info("Rules loaded from strategy bundle", {
          event: "rules_bundle_loaded",
          categories: Object.keys(categories).length,
          structuralPatterns: structuralPatternsData.length,
          version,
        });
      } else {
        logger.info("No rules in strategy bundle, using empty ruleset", {
          event: "rules_empty_fallback",
        });
      }

      // ── 2. Build index ───────────────────────────────────────────────────
      const exactBlacklist = new Set<string>();
      const associativeMap = new Map<string, { category: string; rule: AssociativeRule }>();
      const variantMap = new Map<string, { category: string; rule: AssociativeRule }>();
      const multiHopPatterns = new Map<string, Array<{ pattern: string[]; risk: string }>>();

      for (const [categoryName, category] of Object.entries(categories)) {
        if (!category.associative_map) continue;
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
        if (category.multi_hop_patterns) {
          multiHopPatterns.set(categoryName, category.multi_hop_patterns);
        }
      }

      this.index = {
        exactBlacklist,
        associativeMap,
        variantMap,
        associationPatterns: [],
        evolutionStrategies: [],
        semanticPrimes: new Map(Object.entries(semanticPrimesData)),
        structuralPatterns: structuralPatternsData,
        multiHopPatterns,
        meta: { version, last_updated: lastUpdated, categories: Object.keys(categories) },
        loadedAt: Date.now(),
      };

      logger.info("Rules index built", {
        event: "rules_index_built",
        blacklistSize: exactBlacklist.size,
        structuralPatterns: structuralPatternsData.length,
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

  async injectDecryptedStream(_cipherText: string, _token: string): Promise<boolean> {
    return false;
  }

  checkTimingRisk(date: Date, content: string): TimingFinding | null {
    for (const window of BUILTIN_SENSITIVE_WINDOWS) {
      const windowDate = new Date(date.getFullYear(), window.month - 1, window.day);
      const diffMs = date.getTime() - windowDate.getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      const absDiff = Math.abs(diffDays);
      if (absDiff > window.windowDays) continue;

      const hasForceKeyword = window.forceKeywords.length > 0
        ? window.forceKeywords.some((kw) => content.includes(kw))
        : false;
      const hasRelevanceKeyword = window.relevanceKeywords.some((kw) => content.includes(kw));
      if (!hasForceKeyword && !hasRelevanceKeyword) continue;

      return {
        type: "timing_risk",
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
          if (content.includes(word)) { matchedWords.push(word); }
          else { allMatched = false; break; }
        }
        if (allMatched && matchedWords.length > 0) {
          results.push({ pattern: pattern.pattern, risk: pattern.risk, category, matchedWords });
        }
      }
    }
    return results;
  }

  checkStructuralPatterns(content: string): StructuralMatch[] {
    if (!this.index) return [];
    const { semanticPrimes, structuralPatterns } = this.index;
    if (structuralPatterns.length === 0 || semanticPrimes.size === 0) return [];
    const results: StructuralMatch[] = [];
    for (const pattern of structuralPatterns) {
      if (pattern.minCategoryCount !== undefined) {
        const densityMatches = this.matchByDensity(content, pattern, semanticPrimes);
        if (densityMatches) results.push(densityMatches);
      } else if (pattern.requiredCategories && pattern.requiredCategories.length > 0) {
        const categoryMatches = this.matchByRequiredCategories(content, pattern, semanticPrimes);
        if (categoryMatches) results.push(categoryMatches);
      }
    }
    return results;
  }

  private matchByRequiredCategories(content: string, pattern: StructuralPattern, semanticPrimes: Map<string, string[]>): StructuralMatch | null {
    const categoryHits: Array<{ word: string; position: number }>[] = [];
    for (const catId of pattern.requiredCategories!) {
      const words = semanticPrimes.get(catId);
      if (!words || words.length === 0) return null;
      const hits = findWordsInContent(content, words);
      if (hits.length === 0) return null;
      categoryHits.push(hits);
    }
    let minRange = Infinity;
    let bestMinPos = 0, bestMaxPos = 0;
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
    const cappedHits = categoryHits.map((h) => h.length > 5 ? h.slice(0, 5) : h);
    walk(0, []);
    if (minRange > pattern.windowSize) return null;
    return {
      patternId: pattern.id, riskType: pattern.risk_type, severity: pattern.severity,
      matchedWords: bestWords, windowStart: bestMinPos, windowEnd: bestMaxPos,
      suggestedLevel: pattern.auto_red ? "🔴" : "🟡",
    };
  }

  private matchByDensity(content: string, pattern: StructuralPattern, semanticPrimes: Map<string, string[]>): StructuralMatch | null {
    const threshold = pattern.minCategoryCount!;
    const windowSize = pattern.windowSize;
    const categoryRanges: Array<{ catId: string; hits: Array<{ word: string; position: number }> }> = [];
    for (const [catId, words] of semanticPrimes) {
      const hits = findWordsInContent(content, words);
      if (hits.length > 0) categoryRanges.push({ catId, hits });
    }
    if (categoryRanges.length < threshold) return null;
    type EventPoint = { pos: number; catId: string; word: string; isStart: boolean };
    const events: EventPoint[] = [];
    for (const { catId, hits } of categoryRanges) {
      for (const hit of hits) events.push({ pos: hit.position, catId, word: hit.word, isStart: true });
    }
    events.sort((a, b) => a.pos - b.pos);
    let bestCatCount = 0, bestStart = 0, bestEnd = 0;
    let bestWords: Array<{ category: string; word: string; position: number }> = [];
    for (let i = 0; i < events.length; i++) {
      const winEnd = events[i].pos + windowSize;
      const catSet = new Set<string>();
      const winWords: Array<{ category: string; word: string; position: number }> = [];
      for (let j = i; j < events.length && events[j].pos <= winEnd; j++) {
        catSet.add(events[j].catId);
        winWords.push({ category: events[j].catId, word: events[j].word, position: events[j].pos });
      }
      if (catSet.size > bestCatCount) {
        bestCatCount = catSet.size;
        bestStart = i;
        bestEnd = winEnd;
        bestWords = winWords;
      }
    }
    if (bestCatCount < threshold) return null;
    const hitCount = bestCatCount;
    return {
      patternId: pattern.id, riskType: pattern.risk_type, severity: pattern.severity,
      matchedWords: bestWords, windowStart: events[bestStart]?.pos ?? 0, windowEnd: bestEnd,
      suggestedLevel: pattern.auto_red ? "🔴" : hitCount >= threshold + 1 ? "🔴" : "🟡",
      hitCount, totalCategories: semanticPrimes.size,
    };
  }
}

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

function normalizeConfusableVariant(variant: string): string {
  const confusables: Record<string, string> = { 局: "菊", 橘: "菊", 沮: "菊", 桔: "菊", 瓣: "拌", 拌: "拌", 湿: "石", 势: "石", 诗: "石" };
  return [...variant].map((ch) => confusables[ch] ?? ch).join("");
}
