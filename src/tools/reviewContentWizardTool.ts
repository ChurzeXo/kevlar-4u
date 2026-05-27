import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import { MultiTurnSamplingFunction } from "../execution/base.js";
import { loadAllPersonas, Persona } from "../utils/parser.js";
import { handleReviewContent } from "./reviewTool.js";
import { estimateTokenCost } from "../execution/aggregator.js";
import { DEFAULT_DIMENSIONS_CONFIG, OFFENSIVE_DIMENSION_IDS, formatDimensionSelectionList, parseDimensionSelection, type DimensionsConfig, type OffensiveDimensionId } from "../execution/dimensions.js";
import { logger, getErrorInfo } from "../utils/observability.js";
import type { ToolModule } from "./types.js";

export const reviewContentWizardToolDefinition: Tool = {
  name: "review_content_wizard",
  description:
    "当用户说「审稿/评测/评论这篇/帮我看看这篇文案/内容」时，调用此工具（评论区模拟器）。首次调用时 userMessage 传入待评测内容；工具自动保存内容，由 AI 根据内容特色推荐 1-3 位最合适的评审员，同时展示备选评审员列表。用户可回复编号增加评审员，或回复「开始审稿」确认执行评测。不会在未经用户确认评审员名单的情况下直接执行评测。",
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
          "用户在当前步骤的回复内容。首次调用时传入待评测的完整内容或评测请求（例如用户粘贴了文案，或说「帮我审一下这段文字」）。后续步骤传入用户对工具提问的回复，如编号增加评审员或「开始审稿」确认执行。",
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
  | "collectPlatforms"
  | "selectDimensions"
  | "confirmSelection"
  | "postReview"
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
      return handleReviewerConfirmation(tmpDir, state, personas, userMessage, samplingFn);

    case "selectDimensions":
      return handleDimensionSelection(tmpDir, state, personas, userMessage, samplingFn);

    case "confirmSelection":
      return handleSelectionConfirmation(skillsDir, tmpDir, state, personas, userMessage, samplingFn);

    case "postReview":
      return handlePostReview(tmpDir, state, personas, userMessage);

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
  if (!samplingFn || systemAuditors.length === 0) {
    state.preAuditReport = { dimensions: [], summary: "未配置大模型或未找到系统审查员，跳过初审" };
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

  let highRisk = 0;
  let medRisk = 0;
  for (const r of results) {
    for (const f of r.findings) {
      if (f.suggestedLevel === "🔴") highRisk++;
      else if (f.suggestedLevel === "🟡") medRisk++;
    }
  }

  state.preAuditReport = {
    dimensions: results,
    summary: highRisk > 0 || medRisk > 0
      ? `🔴 高风险项 ${highRisk} 个 · 🟡 中风险项 ${medRisk} 个`
      : "🟢 未发现明显风险项",
  };
  state.step = "checkPersonaInventory";
  await saveState(tmpDir, state);

  return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
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
        state.preAuditReport?.summary ? `【初审结果】${state.preAuditReport.summary}` : "",
        "",
        "当前还没有可用评审员。请先创建至少一个角色，再继续这次内容评测。",
        "",
        "我已经暂存了本次待评测内容；创建角色后，带上这个 sessionId 再次调用 review_content_wizard 即可继续。",
      ].filter(Boolean).join("\n")
    );
  }

  // 仅 1-2 位评审员：直接全选，进入评审员确认
  if (personas.length <= 2) {
    state.selectedPersonaIds = personas.map((p) => p.meta.id);
    state.remainingPersonaIds = [];
    state.step = "waitingForReviewerConfirmation";
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        state.preAuditReport?.summary ? `【初审结果】${state.preAuditReport.summary}\n` : "",
        `当前共有 ${personas.length} 位评审员：`,
        "",
        ...personas.map((p) => `- ${p.meta.name} · ${p.meta.tags.join("、") || "通用"} · ${p.meta.description}`),
        "",
        "以上评审员已全部选中。请向用户展示初审结果和评审员，等待用户确认后回复「开始审稿」进入维度选择。",
        "",
        "等待用户输入后，再调用此工具以继续。",
      ].filter(Boolean).join("\n")
    );
  }

  // 3 位及以上：AI 推荐 1-3 位，其余放入备选
  const recommendation = await recommendPersonas(state, personas, samplingFn);
  const recommendedIds = new Set(recommendation.personaIds);

  state.selectedPersonaIds = recommendation.personaIds;
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
      recommendation.assistantMessage,
      "",
      ...(remainingPersonas.length > 0
        ? [
            "**备选评审员**（回复对应编号可增加）：",
            ...remainingPersonas.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
          ]
        : []),
      "",
      "请向用户展示初审结果和以上推荐结果。用户可回复编号增加评审员，或回复「开始审稿」确认进入维度选择。",
      "",
      "等待用户输入后，再调用此工具以继续。",
    ].filter(Boolean).join("\n")
  );
}

async function handleReviewerConfirmation(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  // 使用全部 / 全选评审员
  if (/使用全部|全部评审|全选评审|所有评审/.test(userMessage)) {
    state.selectedPersonaIds = personas.map((p) => p.meta.id);
    state.remainingPersonaIds = [];
    await saveState(tmpDir, state);
    const selected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
    return toolResponse(
      state,
      [
        `✅ 已选择全部 ${personas.length} 位评审员。`,
        "",
        "当前已选评审员：",
        ...selected.map((p) => `- ${p.meta.name} · ${p.meta.description}`),
        "",
        "请向用户展示，回复「开始审稿」确认进入维度选择。",
      ].join("\n")
    );
  }

  // 通过编号从备选列表增加评审员
  const numIndices = parseNumberIndices(userMessage);
  if (numIndices.length > 0 && state.remainingPersonaIds.length > 0) {
    return addByNumbersWithMessage(tmpDir, state, personas, numIndices);
  }

  // "开始审稿" 或确认类回复 → 进入维度选择
  if (isAffirmative(userMessage)) {
    if (state.selectedPersonaIds.length === 0) {
      return toolResponse(state, "❌ 当前没有已选择的评审员。请回复编号选择评审员后再试。");
    }
    state.step = "selectDimensions";
    await saveState(tmpDir, state);
    const selected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
    return toolResponse(
      state,
      [
        `✅ 评审员已确认，共 ${selected.length} 位：${selected.map((p) => p.meta.name).join("、")}`,
        "",
        "接下来请选择评审维度：",
        "",
        formatDimensionSelectionList(),
        "",
        "默认全部启用。用户可回复编号取消对应进攻性维度，或回复「开始审稿」使用全部维度。",
        "",
        "等待用户输入后，再调用此工具以继续。",
      ].join("\n")
    );
  }

  // 未识别到有效指令 → 重新展示当前评审员状态
  await saveState(tmpDir, state);
  const selected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
  const remaining = personas.filter((p) => state.remainingPersonaIds.includes(p.meta.id));
  return toolResponse(
    state,
    [
      "当前已选评审员：",
      ...selected.map((p) => `- ${p.meta.name} · ${p.meta.description}`),
      "",
      ...(remaining.length > 0
        ? [
            "备选评审员（回复对应编号可增加）：",
            ...remaining.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
            "",
            "请向用户展示，等待用户回复编号增加评审员，或回复「开始审稿」确认进入维度选择。",
          ]
        : ["请向用户展示，等待用户回复「开始审稿」确认进入维度选择。"]),
    ].join("\n")
  );
}

/** 在评审员确认步骤中，根据编号增加评审员并展示结果 */
async function addByNumbersWithMessage(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  numIndices: number[]
): Promise<ToolResult> {
  const toAdd: string[] = [];
  for (const num of numIndices) {
    if (num > 0 && num <= state.remainingPersonaIds.length) {
      toAdd.push(state.remainingPersonaIds[num - 1]);
    }
  }

  if (toAdd.length === 0) {
    await saveState(tmpDir, state);
    return toolResponse(state, "未找到对应编号的评审员，请重新输入。");
  }

  state.selectedPersonaIds = [...state.selectedPersonaIds, ...toAdd];
  state.remainingPersonaIds = state.remainingPersonaIds.filter((id) => !toAdd.includes(id));

  const addedNames = personas.filter((p) => toAdd.includes(p.meta.id)).map((p) => p.meta.name);
  const selected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
  const remaining = personas.filter((p) => state.remainingPersonaIds.includes(p.meta.id));

  await saveState(tmpDir, state);
  return toolResponse(
    state,
    [
      `✅ 已增加评审员：${addedNames.join("、")}`,
      "",
      "当前已选评审员：",
      ...selected.map((p) => `- ${p.meta.name} · ${p.meta.description}`),
      "",
      ...(remaining.length > 0
        ? [`剩余 ${remaining.length} 位备选评审员可增加。`, "回复编号继续增加评审员，或回复「开始审稿」确认进入维度选择。"]
        : ["回复「开始审稿」确认进入维度选择。"]),
    ].join("\n")
  );
}

async function handleDimensionSelection(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  // Parse dimension selection
  if (/开始|审稿|评测|确认|默认|全部维度|ok|yes/i.test(userMessage)) {
    // Use default or already-set dimensions, proceed to confirm
    state.step = "confirmSelection";
    await saveState(tmpDir, state);
    const selected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
    const cost = estimateTokenCost(selected.length, state.content.length);
    return toolResponse(
      state,
      [
        "✅ 评审维度已确认。",
        "",
        `已选评审员：${selected.map((p) => p.meta.name).join("、")}`,
        `激活维度：防御性 4 个（系统强制） + 进攻性 ${state.dimensions.offensive.length} 个`,
        `预估 Token 消耗：约 ${cost.toLocaleString()} tokens`,
        "",
        "请向用户展示以上信息，等待用户确认后回复「开始审稿」以执行评测。",
      ].join("\n")
    );
  }

  // Parse dimension exclusion (numbers refer to offensive dimension indices)
  const newDimensions = parseDimensionSelection(userMessage, state.dimensions);
  state.dimensions = newDimensions;

  // Check if this looks like a "start" intent
  if (state.dimensions.offensive.length === 0) {
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        "⚠️ 至少需要保留一个进攻性维度。请重新选择。",
        "",
        formatDimensionSelectionList(),
        "",
        "请向用户展示维度列表，等待用户回复编号取消对应维度，或回复「开始审稿」使用全部维度。",
      ].join("\n")
    );
  }

  state.step = "confirmSelection";
  await saveState(tmpDir, state);
  const selected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
  const cost = estimateTokenCost(selected.length, state.content.length);
  const excludedCount = OFFENSIVE_DIMENSION_IDS.length - state.dimensions.offensive.length;
  return toolResponse(
    state,
    [
      `✅ 已排除 ${excludedCount} 个进攻性维度，保留 ${state.dimensions.offensive.length} 个。`,
        "",
        `已选评审员：${selected.map((p) => p.meta.name).join("、")}`,
        `激活维度：防御性 4 个（系统强制） + 进攻性 ${state.dimensions.offensive.length} 个`,
        `预估 Token 消耗：约 ${cost.toLocaleString()} tokens`,
        "",
        "请向用户展示以上信息，等待用户确认后回复「开始审稿」以执行评测。",
    ].join("\n")
  );
}

async function handleSelectionConfirmation(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  // 使用全部 / 全选
  if (/使用全部|全部|全选|所有/.test(userMessage)) {
    return selectAllAndConfirm(tmpDir, state, personas);
  }

  // 通过编号从备选列表增加评审员
  const numIndices = parseNumberIndices(userMessage);
  if (numIndices.length > 0 && state.remainingPersonaIds.length > 0) {
    return addByNumbers(tmpDir, state, personas, numIndices);
  }

  // 通过名称或 ID 明确指定
  const explicitIds = extractPersonaIds(userMessage, personas);
  if (explicitIds.length > 0) {
    const newIds = explicitIds.filter((id) => !state.selectedPersonaIds.includes(id));
    if (newIds.length > 0) {
      return addByIds(tmpDir, state, personas, newIds);
    }
  }

  // "开始审稿" 或确认类回复 → 执行评测
  if (isAffirmative(userMessage)) {
    if (state.selectedPersonaIds.length === 0) {
      return toolResponse(state, "❌ 当前没有已选择的评审员。请回复编号选择评审员后再试。");
    }
    return executeReview(skillsDir, tmpDir, state, samplingFn);
  }

  // 未识别到有效指令 → 重新展示当前状态
  await saveState(tmpDir, state);
  const selected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
  const remaining = personas.filter((p) => state.remainingPersonaIds.includes(p.meta.id));
  return toolResponse(
    state,
    [
      "当前已选评审员：",
      ...selected.map((p) => `- ${p.meta.name} · ${p.meta.description}`),
      "",
      ...(remaining.length > 0
        ? [
            "备选评审员（回复编号可增加）：",
            ...remaining.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
            "",
            "请向用户展示当前评审员，等待用户回复编号增加或回复「开始审稿」确认。",
          ]
        : ["请向用户展示当前评审员，等待用户回复「开始审稿」确认执行。"]),
    ].join("\n")
  );
}

async function recommendPersonas(
  state: ReviewWizardState,
  personas: Persona[],
  samplingFn?: MultiTurnSamplingFunction
): Promise<Recommendation> {
  if (samplingFn) {
    try {
      const personaSummary = personas.map((p) => ({
        id: p.meta.id,
        name: p.meta.name,
        tags: p.meta.tags,
        description: p.meta.description,
      }));
      const response = await samplingFn({
        systemPrompt:
          "你是评审员推荐助手。根据待评测内容推荐 1-3 个最匹配的评审员，输出 JSON：{\"personaIds\":[\"id\"],\"assistantMessage\":\"推荐理由+询问确认\"}。assistantMessage 应包含「根据内容特色，为您推荐了 X 位合适的评审员」及每位推荐评审员的简要理由。不要输出 markdown。",
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              content: state.content,
              context: state.context || "",
              personas: personaSummary,
            }),
          },
        ],
        maxTokens: 2048,
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
      "请向用户展示以上推荐结果，等待用户选择。用户可回复编号增加评审员，或回复「开始审稿」确认。",
    ].join("\n"),
  };
}

// ── State transition & selection helpers ──

async function transitionTo(
  tmpDir: string,
  state: ReviewWizardState,
  step: ReviewWizardStep,
  message: string
): Promise<ToolResult> {
  state.step = step;
  await saveState(tmpDir, state);
  return toolResponse(state, message);
}

function personaLineBrief(p: Persona): string {
  return `- ${p.meta.name} (ID: ${p.meta.id}) · ${p.meta.description}`;
}

/** 从用户输入中解析数字编号（用于从备选列表增加评审员） */
function parseNumberIndices(input: string): number[] {
  const numbers: number[] = [];
  const numPattern = /\b([1-9]\d*)\b/g;
  let match;
  while ((match = numPattern.exec(input)) !== null) {
    numbers.push(parseInt(match[1], 10));
  }
  return [...new Set(numbers)]; // 去重
}

/** 根据备选列表中的编号增加评审员 */
async function addByNumbers(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  numIndices: number[]
): Promise<ToolResult> {
  const toAdd: string[] = [];
  for (const num of numIndices) {
    if (num > 0 && num <= state.remainingPersonaIds.length) {
      toAdd.push(state.remainingPersonaIds[num - 1]);
    }
  }

  if (toAdd.length === 0) {
    await saveState(tmpDir, state);
    return toolResponse(state, "未找到对应编号的评审员，请重新输入。");
  }

  state.selectedPersonaIds = [...state.selectedPersonaIds, ...toAdd];
  state.remainingPersonaIds = state.remainingPersonaIds.filter((id) => !toAdd.includes(id));

  const addedNames = personas.filter((p) => toAdd.includes(p.meta.id)).map((p) => p.meta.name);
  const selected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
  const remaining = personas.filter((p) => state.remainingPersonaIds.includes(p.meta.id));

  await saveState(tmpDir, state);
  return toolResponse(
    state,
    [
      `✅ 已增加评审员：${addedNames.join("、")}`,
      "",
      "当前已选评审员：",
      ...selected.map((p) => `- ${p.meta.name} · ${p.meta.description}`),
      "",
      ...(remaining.length > 0
        ? [`剩余 ${remaining.length} 位备选评审员可增加。`, "请向用户展示当前评审员，等待用户确认后回复「开始审稿」。"]
        : ["请向用户展示当前评审员，等待用户确认后回复「开始审稿」。"]),
    ].join("\n")
  );
}

/** 根据名称/ID 增加评审员 */
async function addByIds(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  idsToAdd: string[]
): Promise<ToolResult> {
  const validIds = idsToAdd.filter((id) => state.remainingPersonaIds.includes(id));
  if (validIds.length === 0) {
    await saveState(tmpDir, state);
    return toolResponse(state, "指定的评审员已在列表中或不存在。");
  }

  state.selectedPersonaIds = [...state.selectedPersonaIds, ...validIds];
  state.remainingPersonaIds = state.remainingPersonaIds.filter((id) => !validIds.includes(id));

  const addedNames = personas.filter((p) => validIds.includes(p.meta.id)).map((p) => p.meta.name);
  const selected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
  const remaining = personas.filter((p) => state.remainingPersonaIds.includes(p.meta.id));

  await saveState(tmpDir, state);
  return toolResponse(
    state,
    [
      `✅ 已增加评审员：${addedNames.join("、")}`,
      "",
      "当前已选评审员：",
      ...selected.map((p) => `- ${p.meta.name} · ${p.meta.description}`),
      "",
      ...(remaining.length > 0
        ? [`剩余 ${remaining.length} 位备选评审员可增加。`, "请向用户展示当前评审员，等待用户确认后回复「开始审稿」。"]
        : ["请向用户展示当前评审员，等待用户确认后回复「开始审稿」。"]),
    ].join("\n")
  );
}

async function selectAllAndConfirm(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[]
): Promise<ToolResult> {
  state.selectedPersonaIds = personas.map((p) => p.meta.id);
  state.remainingPersonaIds = [];
  const cost = estimateTokenCost(personas.length, state.content.length);
  return transitionTo(
    tmpDir,
    state,
    "confirmSelection",
    `已选择全部 ${personas.length} 位评审员。\n预估 Token 消耗：约 ${cost.toLocaleString()} tokens\n请向用户展示，等待用户确认后回复「开始审稿」执行评测。`
  );
}

async function selectExplicitAndConfirm(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  selectedIds: string[]
): Promise<ToolResult> {
  state.selectedPersonaIds = selectedIds;
  state.remainingPersonaIds = personas
    .filter((p) => !selectedIds.includes(p.meta.id))
    .map((p) => p.meta.id);
  const names = personas
    .filter((p) => selectedIds.includes(p.meta.id))
    .map((p) => p.meta.name)
    .join("、");
  const cost = estimateTokenCost(selectedIds.length, state.content.length);
  return transitionTo(
    tmpDir,
    state,
    "confirmSelection",
    `已选择：${names}。\n预估 Token 消耗：约 ${cost.toLocaleString()} tokens\n请向用户展示，等待用户确认后回复「开始审稿」执行评测。`
  );
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

  state.step = "postReview";
  await saveState(tmpDir, state);
  const resultText = reviewResult.content[0]?.text || "";
  return toolResponse(state, resultText + "\n\n---\n\n评测完成。是否需要更换评审员再次评审？");
}

async function handlePostReview(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string
): Promise<ToolResult> {
  if (isAffirmative(userMessage)) {
    state.selectedPersonaIds = [];
    state.remainingPersonaIds = [];
    return transitionTo(tmpDir, state, "confirmSelection", [
      "请选择要使用的评审员：",
      "",
      ...personas.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
      "",
      "请向用户展示以上列表，等待用户选择后回复编号增加评审员，或回复「开始审稿」确认。",
    ].join("\n"));
  }

  await cleanupState(tmpDir, state.sessionId);
  return {
    content: [{ type: "text", text: "评测流程已结束。需要评测新内容时，请重新调用 review_content_wizard。" }],
  };
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
        dimensions: { ...DEFAULT_DIMENSIONS_CONFIG },
      };
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

function extractPersonaIds(input: string, personas: Persona[]): string[] {
  // Detect exclusion intent: "不要X" / "不用X" / "排除X" / "去掉X" / "除了X"
  const exclusionPattern = /(?:不要|不用|排除|去掉|除了)\s*([^\s，。,\.]+)/g;
  const excluded = new Set<string>();
  let excludeMatch: RegExpExecArray | null;
  while ((excludeMatch = exclusionPattern.exec(input)) !== null) {
    const term = excludeMatch[1].toLowerCase();
    for (const persona of personas) {
      if (persona.meta.name.toLowerCase().includes(term) || persona.meta.id.toLowerCase().includes(term)) {
        excluded.add(persona.meta.id);
      }
    }
  }

  const selected: string[] = [];
  for (const persona of personas) {
    if (excluded.has(persona.meta.id)) continue;
    const idMatch = input.includes(persona.meta.id);
    // For very short names (≤2 chars), require exact match to prevent false positives
    // e.g. persona named "好" should not match "这篇不好"
    const nameMatch =
      persona.meta.name.length > 2
        ? input.includes(persona.meta.name)
        : input.trim() === persona.meta.name;
    if (idMatch || nameMatch) {
      selected.push(persona.meta.id);
    }
  }
  return selected;
}

function isAffirmative(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  // Short/ambiguous words require exact match to avoid false positives.
  const exactMatchWords = ["是", "对", "好", "y"];
  const containsMatchWords = [
    "确认", "可以", "没问题", "开始", "执行", "ok", "yes",
    "开始审稿", "开始评测", "开始评审", "执行评测",
  ];
  return (
    exactMatchWords.some((w) => normalized === w) ||
    containsMatchWords.some((w) => normalized.includes(w))
  );
}

function stripCodeFence(text: string): string {
  if (!text.startsWith("```")) return text;
  return text.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
}
