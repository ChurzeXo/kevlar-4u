export interface PromptSegments {
  /** 📌 类似先例（供自行检索） */
  precedentSectionHeader: string;
  /** 🔒 类似先例已锁定（Free 展示用） */
  precedentLockedMessage: string;
  /** 暂未检索到类似案例 */
  precedentNoneMessage: string;

  /** buildFinalRenderInstructions — how to render precedents in Turn 3 */
  finalRenderPrecedentInstruction: string;
  /** buildOrchestrationFinalizerPrompt meta-rules item 4 */
  orchestrationMetaRuleItem4: string;
  /** buildOrchestrationFinalizerPrompt Step 8 item 4 */
  orchestrationStep8Item4: string;
  /** buildPreAuditFinalizerPrompt core responsibilities item 4 */
  finalizerCoreItem4: string;

  /** Aggregator locked text (zh-CN) */
  precedentLockedCn: string;
  /** Aggregator locked text (en-US) */
  precedentLockedEn: string;

  /** Free-tier upgrade prompt shown after RST review completes */
  freeTierUpgradePrompt: string;
}
