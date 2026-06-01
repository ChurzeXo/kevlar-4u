import type { Persona } from "../utils/parser.js";

export const TOOL_DESCRIPTION = `内容风险评测向导工具。

**功能**：对用户提交的文本内容进行多维度社会语义风险评估（合规、语境脱嵌、网络文化、事实、社会风险等）。

**触发时机**（当用户意图匹配以下任一情况时调用）：
- 审稿、评测文案、检查社交媒体内容
- 分析帖子/评论风险、争议点、传播风险
- "帮我看看这篇内容"、"分析这段文字风险"等

**核心流程**：
1. 执行系统初审（防御性审查）
2. 展示**确定性生成的初审结果**（必须原样输出，不得改写）
3. 询问用户是否需要进行复审
4. 用户确认后，推荐 1-3 位最匹配的复审评审员
5. 用户确认评审员后，执行完整复审

**严格规则**：
- 必须等待用户明确回复「开始复审」才能执行完整复审
- 换评审员时**不得**重复展示初审结果
- 严禁自动开始复审、跳过确认、连续换人
- 输入必须为纯文本（不支持图片、PDF、文档等文件）

**工具能力边界**：
- 仅输出：风险评测、社会语义分析、传播风险评估、多视角评审意见
- 绝不：修改原文、优化文案、重写内容、提供法律/医疗/投资建议`;

export function buildSandboxSections(systemAuditors: Persona[]): string {
  return systemAuditors
    .map((auditor, index) => {
      const sandbox = auditor.meta.sandbox || { responsibility: "暂无配置", logic: "暂无配置", target: "暂无配置" };
      return [
        `【沙盒 #${index + 1}：${auditor.meta.name}（${auditor.meta.id}）】`,
        `- 职责：${sandbox.responsibility}`,
        `- 逻辑：${sandbox.logic}`,
        `- 目标：${sandbox.target}`,
        ``,
        `<cot_sb${index + 1}>`,
        `逐项检查待审内容，列出属于「${auditor.meta.name}」维度的所有候选风险点。`,
        `对每个候选点逐一判断：是否成立？严重程度（🔴/🟡）？判断理由是什么？`,
        `若确认无风险，明确写出"未发现风险"并说明原因。`,
        `</cot_sb${index + 1}>`,
        ``,
        `<findings_sb${index + 1}>`,
        `输出 JSON 格式的结构化发现。若无风险则输出空数组。`,
        `</findings_sb${index + 1}>`,
      ].join("\n");
    })
    .join("\n\n");
}

export function buildCommonRiskRules(): string {
  return [
    `【重要指令：严格遵守审查边界】`,
    ``,
    `你当前的唯一职责是**进行客观风险识别与分析**。`,
    ``,
    `## 严格禁止的行为`,
    `- 禁止提供任何修改建议（包括但不限于「建议修改为…」「可以改成…」「推荐换成…」）`,
    `- 禁止给出优化、文案润色、重写、弱化、删除等任何指导性意见`,
    `- 禁止使用「你可以…」「建议你…」「更好的表达是…」等句式`,
    ``,
    `## 允许的行为`,
    `- 只做客观的事实判断、风险分析和成因解释`,
    `- 只描述「这个表达可能引发什么风险」「为什么会被这样解读」`,
    `- 只输出结构化的风险发现（Findings）`,
    ``,
    `请严格保持「诊断者」而非「修改者」的心态。违规输出将导致解析失败。`,
  ].join("\n");
}

/**
 * Compact CoT checklist for each system auditor dimension.
 * Derived from each auditor's systemPrompt, adapted for single-inference
 * "matrix filling" mode — pure checklist execution, no role-playing.
 */
function buildCompactAuditorCoT(auditor: Persona): string {
  const id = auditor.meta.id;
  const name = auditor.meta.name;

  const CHECKLISTS: Record<string, string[]> = {
    legal_compliance: [
      `1. 逐句扫描绝对化用语/极限词（"最""第一""唯一"等）和无法证明的行业领先声明`,
      `2. 检测虚假/夸大宣传：虚构数据、误导性比较、无依据的功效承诺`,
      `3. 识别非法医疗/投资建议、政治/历史红线、诱导欺诈、侵犯第三方权益`,
      `4. 检查行业特殊监管（食品/保健品/金融/教培）和未成年人保护违规`,
    ],
    social_risk: [
      `【强制解码流程——必须按顺序执行，不可跳过】`,
      `1. 字面解码：内容在描述什么场景/对象/动作？`,
      `2. 感官词提取：列出所有颜色词、形态词、质地词、部位名词`,
      `3. 组合联想测试：上述词两两/三三组合后，` +
        `脱离原始语境能否触发身体器官、性暗示或低俗联想？` +
        `（重点检查：颜色+形态+部位的三元组合）`,
      `4. 截图攻击模拟：哪一句话单独截图后含义会发生偏移？`,
      `5. 评论区预测：这段内容发布后，恶意评论的第一句会怎么写？`,
      `6. 完成以上五步后，再判断是否存在歧视/物化/阶层/语气风险`,
    ],
    context_distortion: [
      `1. 识别易被截图/断章取义的句子——脱离上下文后语义发生根本性偏移`,
      `2. 评估是否容易被二次创作（P图、恶搞、断章取义、标题党化截取）`,
      `3. 对每个候选点判断：是否有多个解读空间、其中一个是负面的？`,
    ],
    network_culture_risk: [
      `1. 扫描网络黑话、亚文化梗、隐晦低俗含义、缩写/数字暗语/Emoji组合`,
      `2. 识别谐音撞车、跨平台语境误读、粉圈冲突暗语风险`,
      `3. 对每个候选点按"最坏解读"原则判断真实严重程度`,
    ],
    factual_integrity: [
      `1. 检查数据/统计是否有明显错误、单位混淆、计算谬误`,
      `2. 识别常识性错误（科学/历史/地理/文化常识违背）`,
      `3. 检查逻辑漏洞：前后矛盾、因果倒置、以偏概全、循环论证`,
      `4. 识别概念混淆、引用失真、过时信息、过度泛化`,
    ],
  };

  const steps = CHECKLISTS[id];
  if (!steps) {
    return [
      `1. 逐项检查待审内容中属于「${name}」维度的所有风险点`,
      `2. 对每个候选点逐一判断：是否成立？严重程度（🔴/🟡）？判断理由是什么？`,
    ].join("\n");
  }

  return steps.join("\n");
}

export function buildOrchestrationPrompt(userContent: string, systemAuditors: Persona[]): string {
  const sandboxSections = systemAuditors
    .map((auditor) => {
      return [
        `#### 沙盒：${auditor.meta.name}（${auditor.meta.id}）`,
        ``,
        buildCompactAuditorCoT(auditor),
        ``,
        `该维度分析结束后输出 JSON 发现：keyword（风险词汇）、trigger（触发原因）、riskDescription（风险说明）、propagationRisk（传播风险）、suggestedLevel（🔴/🟡）。`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    `# [SYSTEM PROTOCOL] 防御性风险矩阵扫描协议（单次推理版）`,
    ``,
    `## 【元规则】`,
    `1. 运行环境：单次推理孤岛状态，无外部状态机`,
    `2. 执行身份：非情感化的【多维特征分析与语义映射矩阵】`,
    `3. 核心禁令：禁止使用第一人称发言；禁止输出任何修改建议、优化方向、文案润色或重写意见`,
    ``,
    buildCommonRiskRules(),
    ``,
    `## 【待测文案】`,
    `"""`,
    userContent,
    `"""`,
    ``,
    `## 【矩阵填空执行协议】`,
    `请严格按照以下协议流程进行逐项分析，最终只输出标准 JSON。`,
    ``,
    `### Step 1: 零度事实解构（无倾向特征提取热身）`,
    `1. 提取核心关键词及派生词列表`,
    `2. 判断字面语境分类（日常分享/专业科普/商业宣传等）`,
    `3. 列出潜在歧义词/多义词`,
    ``,
    `### Step 2: 五维度语义对撞（硬性协议隔离，防止视角相互污染）`,
    ``,
    sandboxSections,
    ``,
    `### Step 3: 交叉仲裁与噪音过滤`,
    ``,
    `<arbitration_sandbox>`,
    `  <cot_arbitration>`,
    `    1. 逐一审查 Step 2 各沙盒的发现，标记哪些属于过度联想（Noise）`,
    `    2. 合并跨维度重复发现，保留最高风险等级`,
    `    3. 评估被标记为 Noise 的发现是否确实缺乏文本依据`,
    `    4. 确认收敛后的发现列表中【没有包含任何修改建议或文案优化意见】`,
    `  </cot_arbitration>`,
    `  <arbitration_output>`,
    `    输出被过滤的 Noise 列表和保留的最终发现清单（JSON 格式）`,
    `  </arbitration_output>`,
    `</arbitration_sandbox>`,
    ``,
    `### Step 4: 最终 JSON 输出`,
    `请输出以下格式的纯 JSON，不包含任何 Markdown 标记或额外解释：`,
    ``,
    JSON.stringify(
      {
        dimensions: systemAuditors.map((a) => ({
          id: a.meta.id,
          name: a.meta.name,
          findings: [],
          level: "🟢",
        })),
      },
      null,
      2,
    ),
    ``,
    `其中：`,
    `- dimensions 数组覆盖以上 ${systemAuditors.length} 个维度`,
    `- 每个维度的 findings 包含：keyword, trigger, riskDescription, propagationRisk, suggestedLevel`,
    `- 无发现时 findings 为空数组`,
    `- level 根据 findings 自动推算：含 🔴 则为 🔴，含 🟡 则为 🟡，均为空则为 🟢`,
    ``,
    `请严格执行以上流程并输出 JSON：`,
  ].join("\n");
}

export function buildPreAuditFinalizerPrompt(systemAuditors: Persona[]): string {
  return [
    "你是 **Kevlar-4u 系统初审总仲裁官**。",
    "",
    "你的职责是：对所有 system_auditor、本地规则引擎以及交叉验证的结果进行最终聚合、冲突仲裁、风险等级校准，并应用「最坏解读」与「反向风险」两大核心原则。",
    "",
    "【核心元原则】",
    "1. 最坏解读原则：对所有风险点进行「最坏解读」评估 —— 假设被恶意截图、断章取义、带节奏后，最恶劣的解读会是什么？",
    "2. 反向风险原则：同时评估「过度防御」导致的反噬风险（如圣母式、道德绑架、凡尔赛、阴阳怪气、油腻语气等引发普通用户反感）。",
    "3. 在最坏解读与反向风险之间取得平衡，既要防攻击，也要防自身表达过于正确而掉好感。",
    "",
    "你的任务是：",
    "- 合并重复风险、保留最高风险等级",
    "- 对每个 finding 补充或强化最坏解读和反向风险描述",
    "- 补齐缺失审查维度",
    "- 输出标准 JSON",
    "",
    "必须包含以下系统审查员维度：",
    ...systemAuditors.map((auditor) => `- ${auditor.meta.id} / ${auditor.meta.name}`),
    "",
    "输出格式：",
    '{"dimensions":[{"id":"legal_compliance","name":"合规哨兵","findings":[],"level":"🟢"}],"summary":"面向用户展示的初审摘要"}',
  ].join("\n");
}
