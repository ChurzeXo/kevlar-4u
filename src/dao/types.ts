export interface AssociativeRule {
  root: string;
  variants: string[];
  misinterpret_direction: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  base_score: number;
  suggestion: string;
}

export interface RuleCategory {
  enabled: boolean;
  weight: number;
  associative_map: AssociativeRule[];
}

export interface RuleMeta {
  version: string;
  last_updated: string;
  categories: string[];
}

/**
 * Rules data structure as stored in rules.json
 */
export interface RulesData {
  version: string;
  last_updated: string;
  categories: Record<string, RuleCategory>;
}

/**
 * In-memory index structure for O(1) lookup
 */
export interface RulesIndex {
  /** L1: exact blacklist — every variant across all categories */
  exactBlacklist: Set<string>;
  /** L2: root → rule lookup */
  associativeMap: Map<string, { category: string; rule: AssociativeRule }>;
  /** Metadata */
  meta: RuleMeta;
  /** Last loaded timestamp for cache invalidation */
  loadedAt: number;
}
