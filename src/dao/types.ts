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
export interface RulesData {
  version?: string;
  last_updated?: string;
  categories?: Record<string, RuleCategory>;
  core_rules?: CoreRules;
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
}
