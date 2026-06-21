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

  /** Free-tier upgrade hint shown during persona selection (early stage) */
  freeTierUpgradeHint: string;

  /** Core reasoning framework: 职业黑粉 identity (buildCoreReasoningFramework) */
  coreReasoningFramework: string;
  /** Cold-read protocol steps (buildCoreFrameworkSteps) */
  coreFrameworkSteps: string;
  /** Turn 1 global decode protocol system prompt (buildGlobalStep0Prompt) */
  globalStep0Protocol: string;
  /** Turn 1 global decode user message template (buildGlobalStep0Message) */
  globalStep0Message: string;
}
