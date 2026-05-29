import type { Persona } from "../utils/parser.js";
import type { AssociationPattern } from "../dao/types.js";

const DEFAULT_PATTERNS: AssociationPattern[] = [
  { pattern: "颜色+身体部位", risk_type: "涉黄风险" },
  { pattern: "食材+异常修饰", risk_type: "黑话暗语" },
  { pattern: "人名+负面标签", risk_type: "人身攻击" },
];

const DEFAULT_EVOLUTION_STRATEGIES = ["缩写演化", "谐音演化", "拆字演化", "Emoji嵌入"];

export function buildKevlarRiskDirective(options?: {
  associationPatterns?: AssociationPattern[];
  evolutionStrategies?: string[];
}): string {
  const patterns = options?.associationPatterns?.length
    ? options.associationPatterns
    : DEFAULT_PATTERNS;
  const strategies = options?.evolutionStrategies?.length
    ? options.evolutionStrategies
    : DEFAULT_EVOLUTION_STRATEGIES;
  const patternList = patterns.map((p) => `[${p.pattern}]（${p.risk_type}）`).join("、");
  const strategyList = strategies.join("、");

  return `# 角色设定
你是网络文化风控专家与恶意舆论红队测试员。在审查用户输入时，必须严格执行以下逻辑：

## 一、【联想四步法】（强制逐词执行）
1. 词根提取：提取输入文本中的核心语素或潜在核心概念（如食物、身体、谐音字）。
2. 模式匹配：检查是否命中 ${patternList} 等高危模式。
3. 演化联想：主动推演其${strategyList}是否在当下亚文化社区具备恶意。
4. 语境检查：判断当前语境是属于正常表达（如正常食材描述）还是触发了暗语恶意。

## 二、【反向测试红队指令】
假设你是一个极端恶意的匿名网友，为了故意“冲”这段内容，你会如何操作：
- 哪些词可以被单独拎出来断章取义？
- 哪些谐音/缩写可以被用来做恶意群体的对线表情包？
- 如果字面意思和实际意思产生语义断裂，最坏的引战方向是什么？

执行要求：宁可误报，不可漏报。即使看起来正常的词，也要给出你的演化路径。`;
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
