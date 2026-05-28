import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import { MultiTurnSamplingFunction } from "../execution/base.js";
import { loadAllPersonas, Persona } from "../utils/parser.js";
import { handleReviewContent } from "./reviewTool.js";
import { DEFAULT_DIMENSIONS_CONFIG, type DimensionsConfig } from "../execution/dimensions.js";
import { recommendRSTPersonas } from "../execution/rstRecommender.js";
import { logger, getErrorInfo } from "../utils/observability.js";
import type { ToolModule } from "./types.js";

export const reviewContentWizardToolDefinition: Tool = {
  name: "review_content_wizard",
  description:
    `用于对用户提交的文本内容进行多维度社会语义风险评测。

当用户请求以下内容时调用本工具：
- 审稿
- 评测文案
- 评论文章
- 分析帖子风险
- 检查社交媒体内容
- 帮我看看这篇内容
- 分析内容是否存在争议
- 分析内容传播风险
- 检查评论区风险
- 评估内容是否容易引发误解

工具流程：
1. 调度系统审查员执行防御性初审
2. 分析以下风险维度：
   - 合规风险
   - 语境脱嵌风险
   - 网络文化误读
   - 事实硬伤
   - 社会语义风险
3. 初审结束后，必须同时展示：
   - 初审结果
   - 根据初稿推荐的 1-3 位用户创建的复审评审员
4. 展示完成后，必须暂停并等待用户操作

用户交互规则：

用户只能执行以下单一操作之一：

1. 输入「开始复审」
- 进入完整复审流程
- 调度已确认的复审评审员执行完整评审

2. 输入「评审员编号 + 换一位」
例如：
- 2 换一位
- 3 换一位

执行逻辑：
- 仅替换指定评审员
- 重新生成新的评审员推荐列表
- 不重复展示初审结果
- 替换完成后再次等待用户确认

禁止：
- 自动开始复审
- 跳过用户确认
- 一次替换多个评审员
- 未确认直接进入下一阶段
- 自动连续换人
- 用户未明确确认时执行完整评审
- 换评审员时重复执行初审
- 换评审员时重复展示初审结果

输入内容规则：

输入内容必须为纯文本。

支持：
- 推文
- 公告
- 评论
- 长文
- 社交媒体帖子
- 视频文案
- Reddit 帖子
- 新闻稿
- 产品介绍
- 社区公告

不支持：
- 图片
- PDF 文件
- Word 文件
- Excel 文件
- 数据库内容
- 代码仓库
- 二进制文件

不要用于：
- 法律意见
- 医疗建议
- 投资分析
- 代码安全审计
- 图片分析
- 数据库查询
- 财务决策
- 临床诊断

本工具不会：
- 修改原文
- 自动优化文案
- 自动重写内容
- 自动生成公关方案

本工具仅生成：
- 风险评测
- 社会语义分析
- 传播风险分析
- 评审意见
- 多视角反馈`,
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description:
          "评测向导的会话标识。首次调用请留空，工具会自动生成并返回一个 sessionId。后续调用必须传入此值以继续上一次的评测会话。",
      },
      userMessage: {
        type: "string",
        description:
          "用户在当前步骤的回复内容。首次调用时传入待评测的完整内容或评测请求（例如用户粘贴了文案，或说「帮我审一下这段文字」）。后续步骤传入用户对工具提问的回复，如「开始复审」确认执行或「X 换一位」替换评审员。",
      },
    },
    required: ["userMessage"],
  },
};

export interface ReviewWizardInput {
  sessionId?: string;
  userMessage: string;
  samplingFn?: MultiTurnSamplingFunction;
}

type ReviewWizardStep =
  | "systemAudit"
  | "checkPersonaInventory"
  | "waitingForPersonaCreation"
  | "waitingForReviewerConfirmation"
  | "completed";

interface ReviewWizardState {
  sessionId: string;
  createdAt: number;
  step: ReviewWizardStep;
  content: string;
  context?: string;
  targetPlatforms: string[];
  selectedPersonaIds: string[];
  remainingPersonaIds: string[];
  systemAuditorIds: string[];
  dimensions: DimensionsConfig;
  preAuditReport?: any;
}

interface Recommendation {
  personaIds: string[];
  assistantMessage: string;
}

export const reviewContentWizardModule: ToolModule = {
  definition: reviewContentWizardToolDefinition,
  handler: (deps) => async (args) => {
    if (!args) throw new Error("向导需要提供参数");
    const input = args as any;
    input.samplingFn = deps.resolveSamplingFn();
    return await handleReviewContentWizard(deps.skillsDir, deps.tmpDir, input);
  },
};

export async function handleReviewContentWizard(
  skillsDir: string,
  tmpDir: string,
  input: ReviewWizardInput
): Promise<ToolResult> {
  if (!input.userMessage || typeof input.userMessage !== "string") {
    return {
      content: [{ type: "text", text: "❌ 请提供当前步骤的用户回复。" }],
      isError: true,
    };
  }

  try {
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const state = await loadOrCreateState(tmpDir, input);
    const allPersonas = await loadAllPersonas(skillsDir);
    const userPersonas = allPersonas.filter(p => !p.meta.tags.includes("system_auditor"));
    const systemAuditors = allPersonas.filter(p => p.meta.tags.includes("system_auditor"));
    return await advanceWizard(skillsDir, tmpDir, state, userPersonas, systemAuditors, input.userMessage, input.samplingFn);
  } catch (err) {
    const info = getErrorInfo(err);
    logger.error("Review content wizard failed", { event: "review_wizard_error", error: info.code, message: info.message });
    return {
      content: [{ type: "text", text: `❌ 内容评测向导失败：${info.message}` }],
      isError: true,
    };
  }
}

async function advanceWizard(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[], // user personas
  systemAuditors: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  switch (state.step) {
    case "systemAudit":
      return handleSystemAudit(skillsDir, tmpDir, state, personas, systemAuditors, samplingFn);

    case "checkPersonaInventory":
      return handleInventoryCheck(tmpDir, state, personas, samplingFn);

    case "waitingForPersonaCreation":
      return handleInventoryCheck(tmpDir, state, personas, samplingFn);

    case "waitingForReviewerConfirmation":
      return handleReviewerConfirmation(skillsDir, tmpDir, state, personas, userMessage, samplingFn);

    case "completed":
      return toolResponse(state, "这个评测流程已经完成。需要评测新内容时，请重新开始一个会话。");

    default:
      return toolResponse(state, "未知步骤，请重新开始评测流程。");
  }
}

async function handleSystemAudit(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  userPersonas: Persona[],
  systemAuditors: Persona[],
  samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  if (systemAuditors.length === 0) {
    state.preAuditReport = { dimensions: [], summary: "未找到系统审查员，跳过初审" };
    state.step = "checkPersonaInventory";
    await saveState(tmpDir, state);
    return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
  }

  // 规则模式降级（MCP Sampling 不可用时）
  if (!samplingFn) {
    const results = ruleBasedPreAudit(state.content, systemAuditors);
    const summaryLines: string[] = [];
    for (const r of results) {
      const levelIcon = r.level || "🟢";
      summaryLines.push(`${levelIcon} ${r.name}`);
      for (const f of (r.findings || [])) {
        summaryLines.push(`  ${f.suggestedLevel || "⚪"} ${f.dimension || f.description || ""}`);
      }
    }
    state.preAuditReport = { dimensions: results, summary: summaryLines.join("\n") };
    state.systemAuditorIds = systemAuditors.map(a => a.meta.id);
    state.selectedPersonaIds = [...state.systemAuditorIds];
    state.step = "checkPersonaInventory";
    await saveState(tmpDir, state);
    return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
  }

  const results = await Promise.all(
    systemAuditors.map(async (auditor) => {
      try {
        const response = await samplingFn({
          systemPrompt: auditor.systemPrompt,
          messages: [{ role: "user", content: `请审查以下内容：\n\n${state.content}` }],
          maxTokens: 2048,
        });
        const parsed = JSON.parse(stripCodeFence(response.content.trim()));
        return {
          id: auditor.meta.id,
          name: auditor.meta.name,
          findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        };
      } catch (err) {
        logger.warn("System auditor failed", { event: "system_auditor_failed", auditorId: auditor.meta.id, error: getErrorInfo(err).message });
        return { id: auditor.meta.id, name: auditor.meta.name, findings: [] };
      }
    })
  );

  for (const r of results) {
    let dimLevel: string = "🟢";
    for (const f of r.findings) {
      if (f.suggestedLevel === "🔴") { dimLevel = "🔴"; break; }
      if (f.suggestedLevel === "🟡") dimLevel = "🟡";
    }
    (r as any).level = dimLevel;
  }

  const summaryLines: string[] = [];
  for (const r of results) {
    const levelIcon = (r as any).level || "🟢";
    summaryLines.push(`${levelIcon} ${r.name}`);
    for (const f of (r.findings || [])) {
      summaryLines.push(`  ${f.suggestedLevel || "⚪"} ${f.dimension || f.description || ""}`);
    }
  }

  state.preAuditReport = {
    dimensions: results,
    summary: summaryLines.join("\n"),
  };
  state.systemAuditorIds = systemAuditors.map(a => a.meta.id);
  state.selectedPersonaIds = [...state.systemAuditorIds];
  state.step = "checkPersonaInventory";
  await saveState(tmpDir, state);

  return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
}

// ── Rule-based pre-audit fallback (when MCP sampling is unavailable) ──

interface RuleGroup {
  dimension: string;
  keywords: string[];
  description: string;
  yellowThreshold: number;
  redThreshold: number;
}

const PRE_AUDIT_RULES: Record<string, RuleGroup[]> = {
  legal_compliance: [
    { dimension: "合规风险", keywords: ["最", "第一", "唯一", "全网", "绝对", "100%", "百分百", "顶级", "极致", "首创", "独家", "首款"], description: "内容包含疑似绝对化用语或极限词", yellowThreshold: 2, redThreshold: 5 },
    { dimension: "合规风险", keywords: ["根治", "治愈", "永不复发", "保证效果", "疗效", "药到病除", "神效"], description: "内容包含可能的虚假医疗/功效宣称", yellowThreshold: 1, redThreshold: 3 },
    { dimension: "合规风险", keywords: ["保本", "稳赚", "稳赚不赔", "承诺收益", "无风险", "收益率", "翻倍"], description: "内容包含可能的违规金融承诺", yellowThreshold: 1, redThreshold: 3 },
    { dimension: "合规风险", keywords: ["点击领取", "限时优惠", "错过今天", "仅限今日", "立即购买", "马上抢"], description: "内容包含诱导性营销话术", yellowThreshold: 3, redThreshold: 5 },
  ],
  context_distortion: [
    { dimension: "语境脱嵌风险", keywords: ["懂的自然懂", "你懂的", "懂得都懂", "不多说"], description: "内容包含模糊暗示表述，容易被脱离语境放大", yellowThreshold: 1, redThreshold: 3 },
    { dimension: "语境脱嵌风险", keywords: ["据说", "网传", "网曝", "大家说", "有人说", "某专家", "业内人士透露"], description: "内容包含缺乏明确来源的转述", yellowThreshold: 2, redThreshold: 4 },
    { dimension: "语境脱嵌风险", keywords: ["截图", "聊天记录", "录音", "曝光", "实锤"], description: "内容引用非公开/片段化信息", yellowThreshold: 1, redThreshold: 3 },
  ],
  network_culture_risk: [
    { dimension: "网络文化误读", keywords: ["yygq", "yyds", "awsl", "xswl", "nbcs", "u1s1"], description: "内容包含网络缩写/黑话", yellowThreshold: 2, redThreshold: 5 },
    { dimension: "网络文化误读", keywords: ["冲", "带节奏", "引流", "水军", "控评", "举报", "网暴"], description: "内容包含特定社区行为用语", yellowThreshold: 2, redThreshold: 4 },
    { dimension: "网络文化误读", keywords: ["绷不住了", "破防", "麻了", "急了", "典", "孝", "乐"], description: "内容包含梗文化/抽象话表达", yellowThreshold: 3, redThreshold: 5 },
  ],
  factual_integrity: [
    { dimension: "事实硬伤", keywords: ["研究表明", "调查显示", "据统计", "据调查", "报告指出"], description: "内容引用统计/研究但未提供具体来源", yellowThreshold: 1, redThreshold: 3 },
    { dimension: "事实硬伤", keywords: ["一直", "永远", "从来", "所有", "每个", "大家", "全世界", "全国"], description: "内容包含可能过度概括的全称判断", yellowThreshold: 2, redThreshold: 4 },
    { dimension: "事实硬伤", keywords: ["颠覆", "革命性", "前所未有", "史无前例", "划时代", "突破", "重大突破"], description: "内容包含可能夸大的事实性宣称", yellowThreshold: 1, redThreshold: 3 },
  ],
  social_risk: [
    { dimension: "社会语义风险", keywords: ["女司机", "女拳", "男拳", "小仙女", "田园"], description: "内容包含可能引发性别对立的表述", yellowThreshold: 1, redThreshold: 3 },
    { dimension: "社会语义风险", keywords: ["地域黑", "地图炮", "歧视", "看不起", "low"], description: "内容包含可能的歧视性表述", yellowThreshold: 1, redThreshold: 3 },
    { dimension: "社会语义风险", keywords: ["智商税", "割韭菜", "收智商税", "坑"], description: "内容包含可能的群体贬低或对立煽动", yellowThreshold: 1, redThreshold: 3 },
  ],
};

function countOccurrences(text: string, keyword: string): number {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = text.match(new RegExp(escaped, "g"));
  return matches ? matches.length : 0;
}

function ruleBasedPreAudit(
  content: string,
  auditors: Persona[]
): Array<{ id: string; name: string; findings: any[]; level: string }> {
  const results: Array<{ id: string; name: string; findings: any[]; level: string }> = [];
  const lower = content.toLowerCase();

  for (const auditor of auditors) {
    const rules = PRE_AUDIT_RULES[auditor.meta.id];
    if (!rules) {
      results.push({ id: auditor.meta.id, name: auditor.meta.name, findings: [], level: "🟢" });
      continue;
    }

    const findings: any[] = [];

    for (const group of rules) {
      const matchedKeywords = group.keywords.filter(kw => lower.includes(kw));
      if (matchedKeywords.length === 0) continue;

      const totalOccurrences = group.keywords.reduce(
        (sum, kw) => sum + countOccurrences(lower, kw), 0
      );

      let suggestedLevel = "🟢";
      if (totalOccurrences >= group.redThreshold) suggestedLevel = "🔴";
      else if (totalOccurrences >= group.yellowThreshold) suggestedLevel = "🟡";

      findings.push({
        dimension: group.dimension,
        description: `${group.description}（命中：${matchedKeywords.join("、")}，共 ${totalOccurrences} 处）`,
        suggestedLevel,
      });
    }

    let level = "🟢";
    for (const f of findings) {
      if (f.suggestedLevel === "🔴") { level = "🔴"; break; }
      if (f.suggestedLevel === "🟡") level = "🟡";
    }

    results.push({ id: auditor.meta.id, name: auditor.meta.name, findings, level });
  }

  return results;
}

async function handleInventoryCheck(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  if (personas.length === 0) {
    state.step = "waitingForPersonaCreation";
    state.selectedPersonaIds = [];
    state.remainingPersonaIds = [];
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        state.preAuditReport?.summary ? `【初审结果】\n${state.preAuditReport.summary}` : "",
        "",
        "当前还没有可用评审员。请先创建至少一个角色，再继续这次内容评测。",
        "",
        "我已经暂存了本次待评测内容；创建角色后，带上这个 sessionId 再次调用 review_content_wizard 即可继续。",
      ].filter(Boolean).join("\n")
    );
  }

  // 自动选入系统审查员（必选）
  const systemAuditorNames = state.preAuditReport?.dimensions
    ?.map((d: any) => d.name)
    .filter(Boolean)
    .join("、") || "合规、语境脱嵌、网络文化、事实硬伤、社会风险";
  const auditorLine = `✅ 系统审查员（${systemAuditorNames}）已自动选入`;

  // 仅 1-2 位评审员：直接全选，进入评审员确认
  if (personas.length <= 2) {
    state.selectedPersonaIds = [...personas.map((p) => p.meta.id), ...state.systemAuditorIds];
    state.remainingPersonaIds = [];
    state.step = "waitingForReviewerConfirmation";
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        state.preAuditReport?.summary ? `【初审结果】\n${state.preAuditReport.summary}` : "",
        auditorLine,
        "",
        `当前共有 ${personas.length} 位评审员，已全部选中：`,
        "",
        ...personas.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.tags.join("、") || "通用"} · ${p.meta.description}`),
        "",
        "请回复「开始复审」确认执行，或回复「X 换一位」替换指定评审员（例如：2 换一位）。",
      ].filter(Boolean).join("\n")
    );
  }

  // 3 位及以上：AI 推荐 1-3 位，其余放入备选
  const recommendation = await recommendPersonas(state, personas, samplingFn);
  const recommendedIds = new Set(recommendation.personaIds);

  state.selectedPersonaIds = [...recommendation.personaIds, ...state.systemAuditorIds];
  state.remainingPersonaIds = personas
    .filter((p) => !recommendedIds.has(p.meta.id))
    .map((p) => p.meta.id);
  state.step = "waitingForReviewerConfirmation";
  await saveState(tmpDir, state);

  const remainingPersonas = personas.filter((p) => !recommendedIds.has(p.meta.id));
  return toolResponse(
    state,
    [
      state.preAuditReport?.summary ? `【初审结果】${state.preAuditReport.summary}\n` : "",
      auditorLine,
      "",
      recommendation.assistantMessage,
      "",
      ...(remainingPersonas.length > 0
        ? [
            "**备选评审员**（暂未选入）：",
            ...remainingPersonas.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
          ]
        : []),
      "",
      "请回复「开始复审」确认执行，或回复「X 换一位」替换指定评审员（例如：2 换一位）。",
    ].filter(Boolean).join("\n")
  );
}

async function handleReviewerConfirmation(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  const normalized = userMessage.trim();

  // Parse "X 换一位"
  const swapMatch = normalized.match(/^(\d+)\s*换一位$/);
  if (swapMatch) {
    const idx = parseInt(swapMatch[1], 10);
    return handleSwapReviewer(tmpDir, state, personas, idx, samplingFn);
  }

  // "开始复审" → 直接执行完整复审
  if (/^(开始复审|确认复审|执行复审)$/.test(normalized)) {
    const selectedUserCount = state.selectedPersonaIds.filter(
      id => !state.systemAuditorIds.includes(id)
    ).length;
    if (selectedUserCount === 0) {
      return toolResponse(state, "❌ 当前没有已选择的复审评审员。请先通过「X 换一位」选择评审员后再试。");
    }
    return executeReview(skillsDir, tmpDir, state, samplingFn);
  }

  // 未识别 → 重新展示当前评审员状态
  await saveState(tmpDir, state);
  const selectedUserPersonas = personas.filter(
    p => state.selectedPersonaIds.includes(p.meta.id) && !state.systemAuditorIds.includes(p.meta.id)
  );
  const remaining = personas.filter(p => state.remainingPersonaIds.includes(p.meta.id));
  return toolResponse(
    state,
    [
      "当前已选复审评审员：",
      ...selectedUserPersonas.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
      "",
      ...(remaining.length > 0
        ? [`备选评审员（共 ${remaining.length} 位）`, "请回复「X 换一位」替换指定评审员（例如：2 换一位）。"]
        : []),
      "",
      "请回复「开始复审」确认执行，或回复「X 换一位」替换指定评审员。",
    ].join("\n")
  );
}

async function handleSwapReviewer(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  position: number,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  const selectedUserPersonaIds = state.selectedPersonaIds.filter(
    id => !state.systemAuditorIds.includes(id)
  );

  if (position < 1 || position > selectedUserPersonaIds.length) {
    const selected = personas.filter(
      p => state.selectedPersonaIds.includes(p.meta.id) && !state.systemAuditorIds.includes(p.meta.id)
    );
    return toolResponse(
      state,
      [
        `❌ 编号 ${position} 超出范围。当前已选复审评审员：`,
        ...selected.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
        "",
        "请重新输入正确的编号。",
      ].join("\n")
    );
  }

  // 备选池为空，告知用户并询问是否开始评审
  if (state.remainingPersonaIds.length === 0) {
    const selected = personas.filter(
      p => state.selectedPersonaIds.includes(p.meta.id) && !state.systemAuditorIds.includes(p.meta.id)
    );
    return toolResponse(
      state,
      [
        "⚠️ 备选池已没有可替换的评审员。",
        "",
        "当前已选复审评审员：",
        ...selected.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
        "",
        "请回复「开始复审」确认执行。",
      ].join("\n")
    );
  }

  const removedId = selectedUserPersonaIds[position - 1];
  const removedPersona = personas.find(p => p.meta.id === removedId);

  // 从备选池取第一位加入已选，被换下的回到备选池末尾
  const addedId = state.remainingPersonaIds.shift()!;
  state.selectedPersonaIds = state.selectedPersonaIds.filter(id => id !== removedId);
  state.selectedPersonaIds.push(addedId);
  state.remainingPersonaIds.push(removedId);

  state.step = "waitingForReviewerConfirmation";
  await saveState(tmpDir, state);

  const updatedSelected = personas.filter(
    p => state.selectedPersonaIds.includes(p.meta.id) && !state.systemAuditorIds.includes(p.meta.id)
  );
  const remaining = personas.filter(p => state.remainingPersonaIds.includes(p.meta.id));
  const addedPersona = personas.find(p => p.meta.id === addedId);

  return toolResponse(state, [
    `✅ 已替换：${removedPersona?.meta.name || "未知"} → ${addedPersona?.meta.name || "未知"}`,
    "",
    "当前已选复审评审员：",
    ...updatedSelected.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
    "",
    ...(remaining.length > 0
      ? [`备选评审员（共 ${remaining.length} 位）`]
      : []),
    "请回复「开始复审」确认执行，或回复「X 换一位」继续替换。",
  ].join("\n"));
}



async function recommendPersonas(
  state: ReviewWizardState,
  personas: Persona[],
  samplingFn?: MultiTurnSamplingFunction
): Promise<Recommendation> {
  // First try RST-based recommendation for RST-configured personas
  const rstRecommendation = recommendRSTPersonas(
    state.content,
    state.preAuditReport,
    personas,
    state.context || undefined,
  );

  // If RST recommender found matches, use them
  if (rstRecommendation.personaIds.length > 0 && rstRecommendation.assistantMessage) {
    return rstRecommendation;
  }

  // Fall back to AI recommendation if MCP sampling is available
  if (samplingFn) {
    try {
      const personaSummary = personas.map((p) => ({
        id: p.meta.id,
        name: p.meta.name,
        tags: p.meta.tags,
        description: p.meta.description,
      }));
      const include = {
        content: state.content,
        context: state.context || "",
        personas: personaSummary,
      } as Record<string, unknown>;
      if (state.preAuditReport) {
        include.preAuditReport = state.preAuditReport;
      }
      const response = await samplingFn({
        systemPrompt:
          "你是评审员推荐助手。根据待评测内容和系统初审报告推荐 1-3 个最匹配的评审员，输出 JSON：{\"personaIds\":[\"id\"],\"assistantMessage\":\"推荐理由\"}。assistantMessage 应包含「根据内容特色和初审发现的风险点，为您推荐了 X 位合适的评审员」及每位推荐评审员的简要理由。不要输出 markdown。",
        messages: [
          {
            role: "user",
            content: JSON.stringify(include),
          },
        ],
        maxTokens: 3072,
      });
      const parsed = JSON.parse(stripCodeFence(response.content.trim())) as Record<string, unknown>;
      const validIds = new Set(personas.map((p) => p.meta.id));
      const personaIds = Array.isArray(parsed.personaIds)
        ? parsed.personaIds.map(String).filter((id) => validIds.has(id)).slice(0, 3)
        : [];
      if (personaIds.length > 0 && typeof parsed.assistantMessage === "string") {
        return { personaIds, assistantMessage: parsed.assistantMessage };
      }
    } catch (err) {
      const info = getErrorInfo(err);
      logger.warn("AI persona recommendation failed, falling back to heuristic", {
        event: "review_recommendation_fallback",
        error: info.code,
        message: info.message,
      });
    }
  }

  // Final fallback: heuristic recommendation
  return heuristicRecommendation(state, personas);
}

function heuristicRecommendation(state: ReviewWizardState, personas: Persona[]): Recommendation {
  const terms = `${state.content}\n${state.context || ""}`.toLowerCase();
  const scored = personas
    .map((p) => {
      const haystack = [p.meta.name, p.meta.description, ...p.meta.tags, p.systemPrompt]
        .join("\n")
        .toLowerCase();
      const score =
        p.meta.tags.reduce((sum, tag) => sum + (terms.includes(tag.toLowerCase()) ? 2 : 0), 0) +
        (terms.includes(p.meta.name.toLowerCase()) ? 3 : 0);
      return { persona: p, score };
    })
    .sort((a, b) => b.score - a.score);

  const selected = scored.slice(0, Math.min(3, personas.length)).map((item) => item.persona);
  return {
    personaIds: selected.map((p) => p.meta.id),
    assistantMessage: [
      "根据内容特色，为您推荐了以下评审员：",
      "",
      ...selected.map((p) => `- ${p.meta.name}（推荐理由：标签与描述和本次内容更接近）`),
      "",
      "请向用户展示以上推荐结果，等待用户选择。",
    ].join("\n"),
  };
}



async function executeReview(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  const reviewResult = await handleReviewContent(skillsDir, {
    content: state.content,
    persona_ids: state.selectedPersonaIds,
    context: state.context,
    mode: "auto",
    dimensions: state.dimensions,
    preAuditReport: state.preAuditReport,
    samplingFn: samplingFn
      ? async (params) =>
          samplingFn({
            systemPrompt: params.systemPrompt,
            messages: [{ role: "user", content: params.message }],
            maxTokens: params.maxTokens,
          })
      : undefined,
  });

  if (reviewResult.isError) {
    return {
      content: [{ type: "text", text: reviewResult.content[0]?.text || "❌ 评测执行失败。" }],
      isError: true,
    };
  }

  state.step = "completed";
  const resultText = reviewResult.content[0]?.text || "";
  const response = toolResponse(state, resultText + "\n\n---\n\n评测完成。");
  await cleanupState(tmpDir, state.sessionId);
  return response;
}

async function loadOrCreateState(tmpDir: string, input: ReviewWizardInput): Promise<ReviewWizardState> {
  if (input.sessionId && !/^[a-z0-9-]+$/.test(input.sessionId)) {
    throw new Error("sessionId 格式不合法。");
  }

  const sessionId = input.sessionId || `wizard-review-${Math.random().toString(36).substring(2, 10)}`;
  const statePath = getStatePath(tmpDir, sessionId);

  if (input.sessionId && fs.existsSync(statePath)) {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    const state = JSON.parse(raw) as ReviewWizardState;
    // Backward compatibility: ensure dimensions field exists
    if (!state.dimensions) {
      state.dimensions = { ...DEFAULT_DIMENSIONS_CONFIG };
    }
    // 会话超过 10 分钟未活动，清理旧文件并用原始文案重建新会话
    if (Date.now() - state.createdAt > 10 * 60 * 1000) {
      await cleanupState(tmpDir, sessionId);
      return {
        sessionId,
        createdAt: Date.now(),
        step: "systemAudit",
        content: state.content,
        targetPlatforms: [],
        selectedPersonaIds: [],
        remainingPersonaIds: [],
        systemAuditorIds: [],
        dimensions: { ...DEFAULT_DIMENSIONS_CONFIG },
      };
    }
    // Backward compatibility: ensure systemAuditorIds exists
    if (!state.systemAuditorIds) {
      state.systemAuditorIds = [];
    }
    return state;
  }

  return {
    sessionId,
    createdAt: Date.now(),
    step: "systemAudit",
    content: input.userMessage.trim(),
    targetPlatforms: [],
    selectedPersonaIds: [],
    remainingPersonaIds: [],
    systemAuditorIds: [],
    dimensions: { ...DEFAULT_DIMENSIONS_CONFIG },
  };
}

async function saveState(tmpDir: string, state: ReviewWizardState): Promise<void> {
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const statePath = getStatePath(tmpDir, state.sessionId);
  const tmpPath = statePath + ".tmp";
  await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  await fs.promises.rename(tmpPath, statePath);
}

async function cleanupState(tmpDir: string, sessionId: string): Promise<void> {
  const statePath = getStatePath(tmpDir, sessionId);
  try {
    if (fs.existsSync(statePath)) await fs.promises.unlink(statePath);
  } catch (err) {
    const info = getErrorInfo(err);
    logger.warn("Failed to clean review wizard state", {
      event: "review_wizard_cleanup_error",
      path: statePath,
      error: info.code,
      message: info.message,
    });
  }
}

function getStatePath(tmpDir: string, sessionId: string): string {
  return path.join(tmpDir, `${sessionId}_review_wizard.json`);
}

function toolResponse(state: ReviewWizardState, assistantMessage: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          assistantMessage,
          "",
          "```kevlar-state",
          `sessionId: ${state.sessionId}`,
          "workflow: review_content",
          `currentStep: ${state.step}`,
          `targetPlatforms: ${state.targetPlatforms.join(", ") || "none"}`,
          `selectedPersonaIds: ${state.selectedPersonaIds.join(", ") || "none"}`,
          `remainingPersonaIds: ${state.remainingPersonaIds.join(", ") || "none"}`,
          `dimensions: defensive=4(system), offensive=${state.dimensions.offensive.length}`,
          "```",
        ].join("\n"),
      },
    ],
  };
}

function stripCodeFence(text: string): string {
  if (!text.startsWith("```")) return text;
  return text.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
}
