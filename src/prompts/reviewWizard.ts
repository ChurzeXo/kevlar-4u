import type { Persona } from "../utils/parser.js";

export const TOOL_DESCRIPTION = `内容风险评测向导工具。

**功能**：对用户提交的文本内容进行多维度社会语义风险评估（合规、语境脱嵌、网络文化、事实、社会风险等）。

**触发时机**（当用户意图匹配以下任一情况时调用）：
- 审稿、评测文案、检查社交媒体内容
- 分析帖子/评论风险、争议点、传播风险
- "帮我看看这篇内容"、"分析这段文字风险"等

**核心流程**：
1. 执行系统初审（防御性审查）。
2. 展示**初审结果**，同时询问用户是否需要进行复审，并推荐 1-3 位最匹配的复审评审员。
3. 用户确认后，执行完整复审。

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
      const sandbox = auditor.meta.sandbox || {
        responsibility: "暂无配置",
        logic: "暂无配置",
        target: "暂无配置",
      };
      return [
        `【沙盒 #${index + 1}：${auditor.meta.name}（${auditor.meta.id}）】`,
        `- 职责：${sandbox.responsibility}`,
        `- 逻辑：${sandbox.logic}`,
        `- 目标：${sandbox.target}`,
        ``,
        `<cot_sb${index + 1}>`,
        buildCompactAuditorCoT(auditor),
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

function buildCoreReasoningFramework(): string {
  return [
    `## 【强制角色切换：进入职业黑粉模式】`,
    ``,
    `在执行任何维度检查之前，你必须先完成以下思维框架切换：`,
    ``,
    `你不是内容审核员。`,
    `你是一个以挂人为业的职业差评师，你的收入来自找到这段内容里`,
    `最容易被截图、最容易被断章取义、最容易让品牌公关连夜开会的句子。`,
    ``,
    `带着这个身份，重新读一遍这段内容。`,
    `你会截哪一句？你会配什么标题？你预测评论区第一条高赞是什么？`,
    ``,
    `完成上述思考后，再进入你的具体审查维度。`,
  ].join("\n");
}

/**
 * Compact CoT checklist for each system auditor dimension.
 * Derived from each auditor's systemPrompt, adapted for single-inference
 * "matrix filling" mode — pure checklist execution, no role-playing.
 */
export function buildCompactAuditorCoT(auditor: Persona): string {
  const id = auditor.meta.id;
  const name = auditor.meta.name;

  // 核心认知框架注入到每个维度的第一步
  const coreFramework = [
    `【第一步：职业黑粉逆向解码（必须先于一切具体检查执行）】`,
    `按照「核心认知框架」完成「断章取义三步走」：局部截取 → 语境脱嵌 → 情绪重构。`,
    `    能推演出完整攻击链（原始表达 → 截图呈现 → 评论区反应 → 舆情走向）的，`,
    `    直接标记为 🔴 并进入 findings，不需要等到维度专项检查才确认。`,
  ].join("\n");

  // 各维度专项推理方法
  const DIMENSION_REASONING: Record<string, string[]> = {
    // ── 社会风险：网民直觉 ──────────────────────────────────────────────
    social_risk: [
      coreFramework,
      ``,
      `【第二步：网民直觉检查】`,
      ``,
      `□ 让你最想怼的是哪一句？——把整段内容读一遍，哪句话让你第一反应想翻白眼？`,
      `□ 评论区会分成哪几派？——这段内容发出去，评论区会先吵什么？谁和谁对立？`,
      `□ 谁被说成是错的、谁被说成是惨的？——这段话在暗示谁是坏人、谁是受害者？`,
      `□ 今天发这个会不会被联想到最近的热搜？——现在有没有相关的舆论事件正在发酵？`,
    ],

    // ── 合规：网民直觉 ──────────────────────────────────────────────────
    legal_compliance: [
      coreFramework,
      ``,
      `【第二步：合规扫雷】`,
      ``,
      `□ 有没有"最好""第一""包治"这种字眼？——同行看到会直接截图举报的那种。`,
      `□ 这段话是不是在暗示"不用我们的产品就是你的问题"？——制造焦虑式销售也是违规。`,
    ],

    // ── 语境脱嵌：网民直觉 ─────────────────────────────────────────────
    context_distortion: [
      coreFramework,
      ``,
      `【第二步：截图测试】`,
      ``,
      `□ 同一个词在贴吧/微博/NGA 分别什么意思？——同一个词在不同平台可能是完全相反的意思。`,
      `□ 这句话截图出去 15 秒就能让人看懂攻击方向吗？——不需要配字就能带节奏的才是真风险。`,
    ],

    // ── 网络文化：网民直觉 ─────────────────────────────────────────────
    network_culture_risk: [
      coreFramework,
      ``,
      `【第二步：圈层嗅觉】`,
      ``,
      `□ 有没有黑话、缩写、谐音、拼音首字母？——圈内人秒懂、圈外人一脸懵的那种。`,
      `□ 哪句话能让一群人同时产生"恶心"的感觉？——不需要理性分析，直觉就让人不适的词。`,
      `□ 圈外人看到这个词的第一反应是什么？——你觉得是正常用词，路人可能觉得是暗语。`,
    ],

    // ── 事实完整性：网民直觉 ───────────────────────────────────────────
    factual_integrity: [
      coreFramework,
      ``,
      `【第二步：打假测试】`,
      ``,
      `□ 哪个数字被同行看到会直接截图打假？——夸大的数据、编造的案例，同行一眼看穿。`,
      `□ 错误信息被传播时，读者会愤怒还是恐慌？——错误的后果越严重，被打假后的反噬越猛。`,
      `□ 假设这个错误被做成抖音切条，几天能传遍？——一个硬伤被做成短视频后能传播多广。`,
    ],
  };

  const steps = DIMENSION_REASONING[id];

  if (!steps) {
    // 未知维度的通用框架
    return [
      coreFramework,
      ``,
      `【第二步：「${name}」维度专项推理】`,
      ``,
      `A. 基于「断章取义三步走」解码的结果，识别属于「${name}」维度的所有候选风险点`,
      `B. 对每个候选点：攻击链是否完整？完整则标记为 🔴，不完整则为 Noise 过滤`,
      `C. 有没有「情绪重构」阶段发现的攻击点，还没有被 A 步骤覆盖到？`,
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
        `该维度分析结束后输出 JSON 发现：keyword（风险词汇）、trigger（触发原因）、`,
        `riskDescription（风险说明）、propagationRisk（传播风险）、suggestedLevel（🔴/🟡）。`,
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
    // ── 核心认知框架（全局注入）──────────────────────────────────────────
    buildCoreReasoningFramework(),
    ``,
    `## 【待测文案】`,
    `"""`,
    userContent,
    `"""`,
    ``,
    `## 【矩阵填空执行协议】`,
    `请严格按照以下协议流程进行逐项分析，最终只输出标准 JSON。`,
    ``,
    `### Step 0：职业黑粉逆向全局解码（所有沙盒的推理基础）`,
    ``,
    `在进入任何维度沙盒之前，先对整段内容执行一次「断章取义三步走」全局解码：`,
    ``,
    `**① 局部截取（找黑料原子）**：`,
    `- 放大敏感度，寻找任何能被「武器化」的句子或词组。`,
    `- 哪些词/句子在字面、谐音、排版、语气上存在被无限解构和放大讽刺的空间？`,
    `- 列出所有潜在的黑料原子`,
    ``,
    `**② 语境脱嵌（剥离防线）**：`,
    `- 将每个黑料原子剥离所有前后文，孤立审视。`,
    `- 这句话孤立存在时，直觉上会产生什么完全不同的歧义或恶劣反差？`,
    ``,
    `**③ 情绪重构（强行扣帽）**：`,
    `- 结合当前社会痛点，给脱嵌的截图扣上煽动情绪的帽子（如「物化女性」「何不食肉糜」）。`,
    `- 完整攻击链推演：原始表达 → 截图呈现 → 评论区反应 → 舆情走向`,
    `- 能扣上帽子的所有攻击点，直接进入候选 findings，不需要等待各维度沙盒确认`,
    ``,
    `<cot_global>`,
    `执行上述「断章取义三步走」全局解码，输出：`,
    `1. 局部截取的黑料原子列表`,
    `2. 情绪重构的攻击点候选列表（含完整攻击链推演）`,
    `</cot_global>`,
    ``,
    `### Step 1：五维度沙盒推理（基于 Step 0 的输出）`,
    ``,
    `重要提示：每个沙盒的推理必须以 Step 0 的输出为输入，而不是重新从零开始解读内容。`,
    `Step 0 视角B已发现的攻击点，各沙盒负责判断它属于哪个维度并补充风险描述，不需要重新推演。`,
    ``,
    sandboxSections,
    ``,
    `### Step 2：交叉仲裁与噪音过滤`,
    ``,
    `<arbitration_sandbox>`,
    `  <cot_arbitration>`,
    `    1. 逐一审查 Step 1 各沙盒的发现，标记哪些属于过度联想（Noise）`,
    `       判断标准：能否推演出完整攻击链？不能则为 Noise。`,
    `    2. 合并跨维度重复发现，保留最高风险等级`,
    `    3. 检查 Step 0 视角B的候选列表：是否有被各沙盒遗漏的攻击点？`,
    `       有则补入最相关的维度，不可因为「不在某个维度的常规检查范围」而丢弃`,
    `    4. 确认最终发现列表中没有包含任何修改建议或文案优化意见`,
    `  </cot_arbitration>`,
    `  <arbitration_output>`,
    `    输出被过滤的 Noise 列表和保留的最终发现清单（JSON 格式）`,
    `  </arbitration_output>`,
    `</arbitration_sandbox>`,
    ``,
    `### Step 3：最终 JSON 输出`,
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
    `你是 **Kevlar-4u 系统初审总仲裁官**。`,
    ``,
    `你的职责是：对所有 system_auditor、本地规则引擎以及交叉验证的结果进行最终聚合、`,
    `冲突仲裁、风险等级校准，并应用以下核心原则。`,
    ``,
    `## 【核心元原则】`,
    ``,
    `### 原则一：攻击链完整性优先`,
    `风险等级由「攻击链是否完整」决定，而不是由「风险类型是否在清单里」决定。`,
    `能推演出完整攻击链的：原始表达 → 截图呈现 → 评论区反应 → 舆情走向`,
    `    → 无论风险类型，直接标记为 🔴`,
    ``,
    `### 原则二：最坏解读原则`,
    `对所有风险点进行「最坏解读」评估：`,
    `假设被恶意截图、断章取义、带节奏后，最恶劣的解读会是什么？`,
    `视角A（作者意图无辜）不能抵消视角C（攻击链成立）的风险判定。`,
    ``,
    `### 原则三：反向风险原则`,
    `同时评估「过度防御」导致的反噬风险：`,
    `圣母式表达 / 道德绑架 / 凡尔赛 / 阴阳怪气 / 油腻语气`,
    `→ 这些表达可能引发普通用户反感，本身也是风险。`,
    ``,
    `### 原则四：攻击链 vs 反向风险的平衡`,
    `既要防攻击，也要防自身表达过于"正确"而掉好感。`,
    `在两者之间取得平衡，输出最终风险等级。`,
    ``,
    `## 本地规则引擎优先级（重要）`,
    ``,
    `本地规则引擎的发现（source: "local_rule_engine"）是确定性命中，优先级高于 LLM 发现。`,
    `在生成 summary 和 worstCaseNarrative 时，必须将本地规则的发现作为核心输入：`,
    `- 本地规则为 🔴 的发现，必须在 worstCaseNarrative 中体现`,
    `- 本地规则的发现可以独立升级最终风险等级，不需要 LLM 交叉验证`,
    ``,
    `## 你的任务`,
    `- 合并重复风险，保留最高风险等级`,
    `- 对每个 finding 补充或强化攻击链描述`,
    `- 补齐缺失审查维度`,
    `- 检查是否有「跨维度组合风险」：单个维度不触发，但多个维度同时存在时形成的组合风险`,
    `- 生成 worstCaseNarrative：如果风险被引爆，最坏情况是什么样子？面向内容创作者，2-4 句自然语言，不用技术术语`,
    `- 输出标准 JSON`,
    ``,
    `## 必须包含以下系统审查员维度`,
    ...systemAuditors.map((auditor) => `- ${auditor.meta.id} / ${auditor.meta.name}`),
    ``,
    `## 输出格式`,
    [
      `{`,
      `  "dimensions": [{"id":"legal_compliance","name":"合规哨兵","findings":[],"level":"🟢"}],`,
      `  "summary": "面向用户展示的初审摘要",`,
      `  "riskProfile": {`,
      `    "timing_risk": "🟢/🟡/🔴/N/A",`,
      `    "context_risk": "🟢/🟡/🔴/N/A",`,
      `    "cultural_risk": "🟢/🟡/🔴/N/A",`,
      `    "narrative_power_risk": "🟢/🟡/🔴/N/A",`,
      `    "emotion_risk": "🟢/🟡/🔴/N/A",`,
      `    "symbol_risk": "🟢/🟡/🔴/N/A",`,
      `    "propagation_risk": "🟢/🟡/🔴/N/A"`,
      `  },`,
      `  "synergyFlags": {`,
      `    "triggered": ["规则标签1", "规则标签2"],`,
      `    "overallMultiplier": 1.0`,
      `  },`,
      `  "worstCaseNarrative": "2-4 句自然语言，描述最坏传播场景",`,
      `  "deltaRisks": {`,
      `    "bareOnly": ["裸文特有风险列表"],`,
      `    "fullOnly": ["全文特有风险列表"],`,
      `    "stable": ["两轮共有的稳定风险"]`,
      `  }`,
      `}`,
    ].join("\n"),
    ``,
    `summary 字段的写法要求：`,
    `- 如有 🔴 风险：直接描述攻击链和具体攻击路径（如「存在被截图断章取义的风险」「存在被主动裁切二次创作的风险」等）`,
    `- 如有 🟡 风险：描述风险触发条件`,
    `- 如全部通过：简短说明「在哪些维度上通过了」`,
    `- 禁止：笼统的「存在风险请注意」，必须具体到攻击路径`,
    ``,
    `注意：riskProfile、synergyFlags、worstCaseNarrative、deltaRisks 均为可选字段，`,
    `如果对应数据不可用则设为 null 或省略。`,
  ].join("\n");
}
