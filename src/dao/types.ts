export interface AssociativeRule {
  root: string;
  variants: string[];
  misinterpret_direction: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  base_score: number;
  suggestion: string;
}

export interface MultiHopPattern {
  pattern: string[];
  risk: string;
  type: string;
}

export interface RuleCategory {
  enabled?: boolean;
  weight?: number;
  associative_map?: AssociativeRule[];
  multi_hop_patterns?: MultiHopPattern[];
  // Legacy fields for backward compatibility
  name?: string;
  severity?: string;
  rules?: any[];
}

export interface RuleMeta {
  version: string;
  last_updated: string;
  categories: string[];
}

export interface AssociationPattern {
  pattern: string;
  risk_type: string;
}

export interface RiskRoot {
  word: string;
  variants_check: string[];
  risk_type?: string;
  suggestion?: string;
}

export interface CoreRules {
  association_patterns: AssociationPattern[];
  evolution_strategies: string[];
  risk_roots: RiskRoot[];
}

/**
 * Rules data structure as stored in rules.json
 */
// ── L1 语义类别 ──────────────────────────────────────────────────────────

export interface SemanticPrimeCategory {
  description: string;
  words: string[];
}

// ── L2 结构模式 ──────────────────────────────────────────────────────────

export interface StructuralPattern {
  id: string;
  description: string;
  severity: "HIGH" | "MEDIUM";
  /** 指定类别模式：所有 requiredCategories 必须同时有字命中。与 minCategoryCount 二选一 */
  requiredCategories?: string[];
  /** 密度模式：满足至少 N 个不同 L1 类别命中即可。与 requiredCategories 二选一 */
  minCategoryCount?: number;
  /** 首尾命中字之间的最大字符距离 */
  windowSize: number;
  risk_type: string;
  auto_red?: boolean;
}

// ── 检测结果 ─────────────────────────────────────────────────────────────

export interface StructuralMatch {
  patternId: string;
  riskType: string;
  severity: "HIGH" | "MEDIUM";
  matchedWords: Array<{ category: string; word: string; position: number }>;
  windowStart: number;
  windowEnd: number;
  suggestedLevel: "🔴" | "🟡";
  /** 密度模式命中的类别数（仅 minCategoryCount 模式使用） */
  hitCount?: number;
  /** 密度模式总可用类别数（仅 minCategoryCount 模式使用） */
  totalCategories?: number;
}

export interface RulesData {
  version?: string;
  last_updated?: string;
  categories?: Record<string, RuleCategory>;
  core_rules?: CoreRules;
  semantic_primes?: Record<string, SemanticPrimeCategory>;
  structural_patterns?: StructuralPattern[];
}

// ── Phase 0.1 时机节点 ────────────────────────────────────────────────────

export interface SensitiveWindow {
  id: string;
  label: string;
  month: number;
  day: number;
  windowDays: number;
  riskMultiplier: number;
  /** 关联主题词：内容必须命中至少一个才激活系数 */
  relevanceKeywords: string[];
  /** 强制关联词：命中则无条件激活（不依赖其他条件） */
  forceKeywords: string[];
}

export interface TimingFinding {
  type: 'timing_risk';
  windowId: string;
  windowLabel: string;
  daysFromCenter: number;
  riskMultiplier: number;
  /** L1 本地层仅标记是否命中，不决定风险等级（由 LLM L2 层判定） */
  matched: boolean;
  /** 可选：L1 层预估等级，未设置时由 LLM L2 层判定 */
  suggestedLevel?: '🔴' | '🟡';
  description: string;
}

/**
 * In-memory index structure for O(1) lookup
 */
export interface RulesIndex {
  /** L1: exact blacklist — every variant across all categories */
  exactBlacklist: Set<string>;
  /** L2: root → rule lookup */
  associativeMap: Map<string, { category: string; rule: AssociativeRule }>;
  /** L2 fast path: variant → root/rule lookup */
  variantMap: Map<string, { category: string; rule: AssociativeRule }>;
  /** High-risk composition patterns injected into prompts */
  associationPatterns: AssociationPattern[];
  /** Active semantic evolution paths injected into prompts */
  evolutionStrategies: string[];
  /** Metadata */
  meta: RuleMeta;
  /** Last loaded timestamp for cache invalidation */
  loadedAt: number;

  /** L1 语义词典：类别名 → 词列表 */
  semanticPrimes: Map<string, string[]>;
  /** L2 结构模式列表 */
  structuralPatterns: StructuralPattern[];
  /** Multi-hop patterns from rules_free.json */
  multiHopPatterns: Map<string, Array<{ pattern: string[]; risk: string }>>;
}
