import type { AssociativeRule, RuleMeta, RulesIndex } from "./types.js";

export interface IRuleRepository {
  /**
   * Load or hot-reload the rule base into memory.
   * Returns true on success, false on failure.
   */
  loadRules(customBundle?: any): Promise<boolean>;

  /**
   * Get an associative rule by category and root keyword.
   */
  getRuleByRoot(category: string, root: string): Promise<AssociativeRule | null>;

  /**
   * Check if a variant is in the exact blacklist (L1).
   */
  isBlacklisted(variant: string): boolean;

  /**
   * Get all variant→root mappings for a given variant (L2 lookup).
   */
  resolveVariant(variant: string): Array<{ category: string; rule: AssociativeRule }>;

  /**
   * Get the current rule metadata.
   */
  getMeta(): Promise<RuleMeta>;

  /**
   * Get the full in-memory index (for hot-reload / debug).
   */
  getIndex(): RulesIndex | null;

  /**
   * Phase 2 stub: decrypt and inject a remote rule stream into memory.
   * In Phase 1 this is a no-op placeholder.
   */
  injectDecryptedStream(_cipherText: string, _token: string): Promise<boolean>;
}
