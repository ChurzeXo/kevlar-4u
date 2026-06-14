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
}

export const DEFAULT_FREE_PROMPTS: PromptSegments = {
  precedentSectionHeader: "📌 类似先例（供自行检索）",
  precedentLockedMessage:
    "🔒 类似先例已锁定（升级 Pro 会员查看真实品牌翻车案例与溯源对比，规避同行风险）。",
  precedentNoneMessage: "暂未检索到类似案例",
  finalRenderPrecedentInstruction: [
    '后面紧接输出一行："📌 类似先例（供自行检索）："',
    '后面紧接输出一行："🔒 类似先例已锁定（升级 Pro 会员查看真实品牌翻车案例与溯源对比，规避同行风险）。"',
  ].join("\n       "),
  orchestrationMetaRuleItem4: [
    "4. 本轮职责：执行 Step 6（交叉验证）+ Step 8（最终仲裁），",
    "基于代码层已完成的 Step 5（合并）+ Step 7（协同加权）结果。",
    "注意：当前处于免费版模式，在 worstCaseNarrative 推演中禁止泄露或提及 ",
    "precedents 中任何具体品牌和事件的名称，只做抽象推演。",
  ].join(""),
  orchestrationStep8Item4: [
    "4. **场景推演**：生成攻击链分析（attackChainAnalysis）、",
    "最坏情况的舆情传播剧本（worstCaseNarrative），",
    "以及类似事件先例列表（precedents，若 Turn 1 已检索到则必须输出。",
    "注意：但在最坏情况推演 worstCaseNarrative 中，",
    "必须以抽象方式融入其历史教训，不得直接泄露具体品牌和事件的真实名字）",
  ].join(""),
  finalizerCoreItem4: [
    "4. 场景推演：生成攻击链分析（attackChainAnalysis）、",
    "最坏情况的舆情传播剧本（worstCaseNarrative），",
    "并在其中融入类似先例的历史教训。",
    "注意：当前处于免费版模式，在最坏情况推演（worstCaseNarrative）",
    "与攻击链分析中，禁止泄露或提及 precedents 中任何具体品牌和事件的真实名字，只做抽象推演。",
  ].join(""),
  precedentLockedCn:
    "🔒 类似先例已锁定（升级 Pro 会员查看真实品牌翻车案例与溯源对比，规避同行风险）。",
  precedentLockedEn:
    "🔒 Similar precedents locked (Upgrade to Pro to view real brand failures and root-cause analysis).",
};
