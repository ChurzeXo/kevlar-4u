import type { Persona } from "../utils/parser.js";

export function buildKevlarRiskDirective(_options?: unknown): string {
  return `【❌ 铁律军规：严禁给出修改建议 ❌】
你的职责是【只做客观判决与成因解释】，绝对不允许教用户如何修改文案！禁止输出任何诸如"建议修改为..."、"建议删除..."、"建议使用更温和的词汇..."等引导、重写或修改建议！违者将导致解析失败。

【核心工作法：独立沙盒隔离】
为了防止各维度标准混淆导致角色偏移，你必须将大脑切分为多个完全独立的"虚拟沙盒栏位"。在处理某个审查维度时，必须且仅针对待审计内容进行分析，绝对不允许带入其他维度的逻辑。`;
}

export function buildPseudoParallelDirective(personas: Persona[]): string {
  const pseudoCode = personas.map((persona, index) => {
    const agent = index + 1;
    return [
      `# Agent ${agent}: [${persona.meta.name}] 执行独立审查`,
      `agent${agent}_output = ${safeFunctionName(persona.meta.name)}审查(content)`,
      `audit_results.append(("${persona.meta.name}", agent${agent}_output))`,
    ].join("\n");
  }).join("\n\n");

  const outputBlocks = personas.map((persona, index) => {
    return `═══════════════════════════════════════
▶ 审查员 ${index + 1} 号：[${persona.meta.name}]
═══════════════════════════════════════
【独立声明】我声明我的评估不参考任何其他角色。
[独立思考过程（必须包含联想四步法）]
[结论：🟢安全 / 🟡低危提示 / 🔴高危建议]`;
  }).join("\n\n");

  return `# 并行模拟执行规范
你将同时扮演 ${personas.length} 个相互隔离、毫无交集的独立审查员。请严格按照以下 Python 伪代码的逻辑和结构顺序执行，不得跳过任何一个 Agent 的思考。

\`\`\`python
# 伪代码：模拟独立Agent并行执行并 append 结果
audit_results = []

${pseudoCode}

# 汇总层（仅在所有人独立完成后）
final_report = merge_all(audit_results)
\`\`\`

不得使用“正如前一位审查员所说”“同上”“我同意上一位”等跨角色引用。每个审查员必须只依据待审内容、自己的角色设定和联想四步法独立输出。

${outputBlocks}

═══════════════════════════════════════
▶ 最终风控合并报告
═══════════════════════════════════════
[汇总冲突点与极限排雷建议]`;
}

function safeFunctionName(name: string): string {
  return name.replace(/[^\p{L}\p{N}_]/gu, "");
}
