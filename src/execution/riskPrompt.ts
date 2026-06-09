import type { Persona } from "../utils/parser.js";
import { buildCommonRiskRules } from "../prompts/reviewWizard.js";

export function buildKevlarRiskDirective(_options?: unknown): string {
  return buildCommonRiskRules() + `

## 独立沙盒隔离
你必须将大脑切分为多个完全独立的"虚拟沙盒栏位"。在处理某个审查维度时，必须且仅针对待审计内容进行分析，绝对不允许带入其他维度的逻辑。

请严格保持「诊断者」而非「修改者」的心态。违规输出将导致解析失败。`;
}

/**
 * 构建伪并行执行规范（仅声明式头部，不含 outputBlocks）
 *
 * 每个审查员的输出结构由 personaBlocks 中的 <cot_N> / <findings_N>
 * 和 PERSONA_END 标记定义，此处只声明执行规则避免双重输出框架。
 */
export function buildPseudoParallelDirective(personas: Persona[]): string {
  const personaNames = personas.map((p, i) => `审查员 ${i + 1} 号 [${p.meta.name}]`).join("、");

  return `\
# 并行模拟执行规范

你将依次扮演 ${personas.length} 个相互隔离的独立审查员：${personaNames}。

执行规则：
- 每个审查员执行时，【只能】基于"待审内容"和自身角色定义作出判断。
- 严禁使用"正如前一位审查员所说""同上""我同意上一位"等任何跨角色引用。
- 必须先完整输出 <cot_N>（推理过程），再输出 <findings_N>（最终结论），不得颠倒或合并。
- 每个审查员输出完毕后，必须输出 <!-- KEVLAR_PERSONA_END:N --> 标记。
- 所有审查员执行完毕后，按下方「最终汇总报告」格式输出合并报告。`;
}

function safeFunctionName(name: string): string {
  return name.replace(/[^\p{L}\p{N}_]/gu, "");
}
