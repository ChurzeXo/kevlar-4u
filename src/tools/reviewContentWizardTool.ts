import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import { MultiTurnSamplingFunction } from "../execution/base.js";
import { loadAllPersonas, Persona } from "../utils/parser.js";
import { handleReviewContent } from "./reviewTool.js";
import { DEFAULT_DIMENSIONS_CONFIG, DEFENSIVE_DIMENSION_IDS, type DimensionsConfig } from "../execution/dimensions.js";
import { recommendRSTPersonas } from "../execution/rstRecommender.js";
import { logger, getErrorInfo } from "../utils/observability.js";
import { isValidSessionId } from "../utils/sessionId.js";
import type { ToolModule } from "./types.js";
import { LocalJsonRuleRepository } from "../dao/LocalJsonRuleRepository.js";
import { isPro } from "../subscription/tier.js";
import { SaaSClient } from "../utils/saasClient.js";
import { type PromptSegments } from "../subscription/promptTypes.js";
import { loadPromptSegments } from "../subscription/promptTemplates.js";
import type { StrategyProvider, ReviewPlan } from "../execution/strategy.js";
import { callConfiguredDirectApi, hasApiKey } from "../execution/modes/direct_api.js";
import { calculateSynergy } from "../execution/synergyCalculator.js";
import { stripContext } from "../utils/stripContext.js";
import {
  TOOL_DESCRIPTION,
  LEGACY_RENDERING_SECTION,
  buildOrchestrationStep0Prompt,
  buildOrchestrationAuditPrompt,
  buildOrchestrationFinalizerPrompt,
  type OrchestrationPreAuditContext,
  type Precedent,
  type Step0Result,
} from "../prompts/reviewWizard.js";
import {
  type AuditLlmCaller,
  type PreAuditDimensionResult,
  type PreAuditReport,
  type ReviewStepId,
  type ReviewStepKind,
  type BaseReviewStep,
  type InlineStep,
  type OrchestrationTurnStep,
  type ReviewStepContext,
  type ReviewStepResult,
  getFindingsLevel,
  buildEmptyDeltaRisks,
  normalizePreAuditDimensions,
  mergeLocalFindingsIntoAudits,
  computeDeltaAnalysis,
  executeFullPipeline,
  stepStripContext,
  stepBareAudit,
  stepFullAudit,
  stepDeltaAnalysis,
  stepMergeLocalFindings,
  stepCrossValidation,
  stepSynergyWeighting,
  stepFinalArbitration,
  orchestrationStep0,
  orchestrationAudit,
  orchestrationFinal,
} from "../execution/reviewSteps.js";


const ORCHESTRATION_STEP0_GUIDANCE = [
  "⚠️ **当前无独立 LLM 能力，需要你执行 Turn 1：Step 0 全局解码**",
  "",
  "请按以下步骤操作：",
  "1. 阅读下方 Step 0 协议，执行「断章取义四步走」全局解码",
  "2. 输出纯 JSON（blackAtoms + attackCandidates + wildTranslations + precedents），不含 Markdown",
  "3. 将 JSON 作为 userMessage 再次调用本工具（Turn 1 提交）",
  "",
  "**调用示例**：",
  "```",
  "review_content_wizard(",
  '  sessionId="wizard-review-xxxxx",',
  '  userMessage="{\\"blackAtoms\\":[...],\\"attackCandidates\\":[...],\\"wildTranslations\\":[...],\\"precedents\\":[...]}"',
  ")",
  "```",
  "",
  "**注意事项**：",
  "- sessionId 必须与当前会话一致",
  "- userMessage 必须是纯 JSON，包含 blackAtoms、attackCandidates、wildTranslations 和 precedents",
  "",
  "---",
  "",
].join("\n");

const ORCHESTRATION_AUDIT_GUIDANCE = [
  "---",
  "",
  "> ⏳ **Kevlar 审计进行中，请稍候...**",
  "> 本轮为 Turn 2 维度沙盒审计，Step 0 全局解码 + 联网搜索已完成。",
  "> 将执行：Steps 2～4 各维度相互独立审计，预计耗时 5～15 秒。",
  "",
  "---",
  "",
  "⚠️ **Turn 1 联网验证已完成，需要你执行 Turn 2：维度沙盒审计（仅 Steps 2-4）**",
  "",
  "请按以下步骤操作：",
  "1. 阅读下方协议（Step 0 结果已注入），执行各维度沙盒推理",
  "2. 按协议执行分析，输出纯 JSON（不含 Markdown）",
  "3. 将 JSON 作为 userMessage 再次调用本工具（Turn 2 提交）",
  "",
  "**调用示例**：",
  "```",
  "review_content_wizard(",
  '  sessionId=\"wizard-review-xxxxx\",',
  '  userMessage=\"{\\\\\"dimensions\\\\\":[...],\\\\\"deltaRisks\\\\\":{...}}\"',
  ")",
  "```",
  "",
  "**注意事项**：",
  "- sessionId 必须与当前会话一致",
  "- userMessage 必须是纯 JSON，包含 dimensions 数组和 deltaRisks 对象",
  "- 本轮不需要输出 summary/synergyFlags/worstCaseNarrative 等字段",
  "",
  "---",
  "",
].join("\n");

const ORCHESTRATION_FINAL_GUIDANCE = [
  "---",
  "",
  "> ⏳ **Kevlar 审计进行中，请稍候...**",
  "> 本轮为 Turn 3 最终仲裁，代码层已完成 Step 5 合并 + Step 7 协同加权。",
  "> 将执行：Step 6 交叉验证 + Step 8 最终仲裁，预计耗时 5～10 秒。",
  "",
  "---",
  "",
  "⚠️ **Turn 2 审计已完成，系统已完成 Step 5 合并 + Step 7 协同加权，需要你执行 Turn 3：交叉验证 + 最终仲裁**",
  "",
  "请按以下步骤操作：",
  "1. 阅读下方协议，代码层确定性结果已注入",
  "2. 执行 Step 6 交叉验证 + Step 8 最终仲裁",
  "3. 输出纯 JSON（不含 Markdown），将 JSON 作为 userMessage 再次调用本工具（Turn 3 提交）",
  "",
  "**调用示例**：",
  "```",
  "review_content_wizard(",
  '  sessionId=\"wizard-review-xxxxx\",',
  '  userMessage=\"{\\\\\"dimensions\\\\\":[...],\\\\\"summary\\\\\":\\\\\"...\\\\\",\\\\\"worstCaseNarrative\\\\\":\\\\\"...\\\\\"}\"',
  ")",
  "```",
  "",
  "**注意事项**：",
  "- sessionId 必须与当前会话一致",
  "- userMessage 必须是纯 JSON，包含完整的 dimensions、summary、worstCaseNarrative 等字段",
  "",
  "---",
  "",
].join("\n");

export const reviewContentWizardToolDefinition: Tool = {
  name: "review_content_wizard",
  description: process.env.KEVLAR_USE_LEGACY_PROMPT === "1" ? `${TOOL_DESCRIPTION}\n\n${LEGACY_RENDERING_SECTION}` : TOOL_DESCRIPTION,

  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "会话ID。首次调用时留空（工具会自动生成并返回）。后续调用必须传入相同 sessionId 以维持会话状态。",
      },
      userMessage: {
        type: "string",
        description:
          "用户当前输入内容。首次调用时传入待评测的完整文本或评测请求；后续交互时传入用户指令（如「开始复审」或「2 换一位」）。必须为纯文本。",
      },
    },
    required: ["userMessage"],
  },
};

export interface ReviewWizardInput {
  sessionId?: string;
  userMessage: string;
  samplingFn?: MultiTurnSamplingFunction;
  sendProgress?: (message: string) => void;
  strategyProvider?: StrategyProvider;
}

type ReviewWizardStep =
  | "systemAudit"
  | "waitingForOrchestrationStep0" // 宿主编排 Turn 1: 等待 Step 0 JSON
  | "waitingForOrchestrationAudit" // 宿主编排 Turn 2: 等待维度审计 JSON
  | "waitingForOrchestrationFinal" // 宿主编排 Turn 3: 等待交叉验证 + 最终仲裁 JSON
  | "checkPersonaInventory"
  | "waitingForPersonaCreation"
  | "waitingForReviewDecision"
  | "waitingForReviewerConfirmation"
  | "rstConfirmation"
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
  tier?: "free" | "pro";
  strategySessionId?: string;
  strategyHash?: string;
  orchestrationPreAuditContext?: OrchestrationPreAuditContext;
  orchestrationTurn2Results?: {
    // Turn 2 审计结果，用于 Turn 3 的中间状态
    mergedDimensions: PreAuditDimensionResult[];
    synergyResult: {
      triggered: string[];
      overallMultiplier: number;
      levelUpgrades: Array<{ dimension: string; from: string; to: string; reason: string }>;
    };
    deltaRisks: { bareOnly: string[]; fullOnly: string[]; stable: string[] };
  };
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
    input.sendProgress = deps.sendProgress;
    input.strategyProvider = deps.strategyProvider;
    return await handleReviewContentWizard(deps.skillsDir, deps.tmpDir, input);
  },
};

export async function handleReviewContentWizard(
  skillsDir: string,
  tmpDir: string,
  input: ReviewWizardInput,
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
    const userPersonas = allPersonas.filter((p) => !p.meta.tags.includes("system_auditor"));
    const systemAuditors = allPersonas.filter((p) => p.meta.tags.includes("system_auditor"));

    // Resolve strategy plan once, freeze for run duration
    const strategyProvider = input.strategyProvider;
    let plan: ReviewPlan | undefined;
    if (strategyProvider && !state.strategySessionId) {
      plan = await strategyProvider.getReviewPlan();
      state.tier = plan.tier;
      state.strategySessionId = plan.strategySessionId;
      state.strategyHash = plan.strategyHash;
    } else if (state.strategySessionId) {
      // Reconstruct plan from frozen state (no re-resolution)
      plan = {
        tier: state.tier as "free" | "pro",
        steps: state.tier === "free" ? ["rst_review"] : [],
        visibility: {
          preAuditDetails: state.tier === "pro" ? "full" : "hidden",
          upgradePrompt: state.tier === "free" ? "after_rst" : "disabled",
          rstContinuationPrompt: state.tier === "pro" ? "after_pre_audit" : undefined,
        },
        strategySessionId: state.strategySessionId,
        strategyVersion: "1.0.0",
        strategyHash: state.strategyHash ?? "",
      };
    }
    const isFreeTier = state.tier === "free";

    if (isFreeTier && state.step === "systemAudit") {
      state.step = "checkPersonaInventory";
      await saveState(tmpDir, state);
    }

    return await advanceWizard(
      skillsDir,
      tmpDir,
      state,
      userPersonas,
      systemAuditors,
      input.userMessage,
      input.samplingFn,
      input.sendProgress,
      plan,
    );
  } catch (err) {
    const info = getErrorInfo(err);
    logger.error("Review content wizard failed", {
      event: "review_wizard_error",
      error: info.code,
      message: info.message,
    });
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
  samplingFn?: MultiTurnSamplingFunction,
  sendProgress?: (message: string) => void,
  plan?: ReviewPlan,
): Promise<ToolResult> {
  switch (state.step) {
    case "systemAudit":
      return handleSystemAudit(skillsDir, tmpDir, state, personas, systemAuditors, samplingFn, sendProgress);

    case "waitingForOrchestrationStep0":
      return handleOrchestrationStep0Result(
        skillsDir,
        tmpDir,
        state,
        personas,
        systemAuditors,
        userMessage,
        samplingFn,
      );

    case "waitingForOrchestrationAudit":
      return handleOrchestrationAuditResult(tmpDir, state, personas, systemAuditors, userMessage, samplingFn);

    case "waitingForOrchestrationFinal":
      return handleOrchestrationFinalResult(tmpDir, state, personas, systemAuditors, userMessage, samplingFn);

    case "checkPersonaInventory":
      return handleInventoryCheck(tmpDir, state, personas, samplingFn);

    case "waitingForPersonaCreation":
      return handleInventoryCheck(tmpDir, state, personas, samplingFn);

    case "waitingForReviewDecision":
      return handleReviewDecision(skillsDir, tmpDir, state, personas, userMessage, samplingFn);

    case "waitingForReviewerConfirmation":
      return handleReviewerConfirmation(skillsDir, tmpDir, state, personas, userMessage, samplingFn);

    case "rstConfirmation":
      return handleRstConfirmation(tmpDir, state, personas, userMessage, samplingFn);

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
  samplingFn?: MultiTurnSamplingFunction,
  sendProgress?: (message: string) => void,
): Promise<ToolResult> {
  const localFindings = await buildLocalRuleFindings(skillsDir, state.content);

  if (systemAuditors.length === 0) {
    const dimensions =
      localFindings.length > 0
        ? [
            {
              id: "local_rule_engine",
              name: "本地规则引擎",
              findings: localFindings,
              level: getFindingsLevel(localFindings),
            },
          ]
        : [];
    state.preAuditReport = {
      dimensions,
      summary:
        dimensions.length > 0 ? summarizePreAuditResults(dimensions) : "未找到系统审查员，且本地规则未命中风险点",
    };
    state.step = state.tier === "pro" ? "rstConfirmation" : "checkPersonaInventory";
    await saveState(tmpDir, state);
    if (state.step === "rstConfirmation") {
      return toolResponse(
        state,
        [
          "六维初审已完成（本地规则模式）。是否继续进行 RST 仿真评审，让虚拟读者基于上述风险点模拟真实反应？",
          "",
          "回复「继续」或「是」进入评审，回复「否」结束。",
        ].join("\n"),
      );
    }
    return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
  }

  if (process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK === "1") {
    const mergedResults = await mergeLocalFindingsIntoAudits(
      systemAuditors.map((auditor) => ({
        id: auditor.meta.id,
        name: auditor.meta.name,
        findings: [],
        level: "🟢",
      })),
      localFindings,
    );
    const results = normalizePreAuditDimensions(mergedResults, systemAuditors);
    state.preAuditReport = { dimensions: results, summary: summarizePreAuditResults(results) };
    state.systemAuditorIds = systemAuditors.map((a) => a.meta.id);
    state.step = state.tier === "pro" ? "rstConfirmation" : "checkPersonaInventory";
    await saveState(tmpDir, state);
    if (state.step === "rstConfirmation") {
      return toolResponse(
        state,
        [
          "六维初审已完成（本地回退模式）。是否继续进行 RST 仿真评审，让虚拟读者基于上述风险点模拟真实反应？",
          "",
          "回复「继续」或「是」进入评审，回复「否」结束。",
        ].join("\n"),
      );
    }
    return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
  }

  // All modes: host AI performs Step 0b (decoding) + web search
  const stripped = stripContext(state.content);
  state.step = "waitingForOrchestrationStep0";
  state.orchestrationPreAuditContext = { localFindings, stripped };
  await saveState(tmpDir, state);
  return toolResponse(
    state,
    ORCHESTRATION_STEP0_GUIDANCE + buildOrchestrationStep0Prompt(state.content, localFindings, stripped),
  );
}

function buildOrchestrationPreAuditContext(
  content: string,
  localFindings: any[],
  step0Result?: Step0Result,
  webContextMap?: Record<string, string>,
  precedents?: Precedent[],
): OrchestrationPreAuditContext {
  return {
    localFindings,
    stripped: stripContext(content),
    step0Result,
    webContextMap,
    precedents,
  };
}

async function resolvePromptSegments(): Promise<PromptSegments> {
  if (isPro()) {
    const serverPrompts = await SaaSClient.fetchSubscriptionPrompts();
    return serverPrompts ?? loadPromptSegments("free");
  }
  return loadPromptSegments("free");
}

/**
 * Handle orchestration Turn 1: parse Step 0 JSON from host AI,
 * run unified web search, then emit Turn 2 (audit) prompt.
 */
async function handleOrchestrationStep0Result(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  userPersonas: Persona[],
  systemAuditors: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  try {
    const parsed = JSON.parse(stripCodeFence(userMessage.trim()));

    // webContextMap is provided by host AI (from its own web search)
    const webContextMap: Record<string, string> = {};
    if (parsed.webContextMap && typeof parsed.webContextMap === "object" && !Array.isArray(parsed.webContextMap)) {
      for (const [key, value] of Object.entries(parsed.webContextMap)) {
        if (typeof value === "string") {
          webContextMap[key] = value;
        }
      }
    }

    // precedents is provided by host AI (from its own web search)
    const precedents: Precedent[] = [];
    if (Array.isArray(parsed.precedents)) {
      for (const item of parsed.precedents) {
        if (item && typeof item === "object" && typeof item.event === "string") {
          precedents.push({
            event: item.event,
            date: typeof item.date === "string" ? item.date : undefined,
          });
        }
      }
    }
    logger.info("Turn 1 step0Result parsed", {
      event: "orchestration_step0_parsed",
      blackAtomsCount: (parsed.blackAtoms ?? []).length,
      attackCandidatesCount: (parsed.attackCandidates ?? []).length,
      precedentsCount: precedents.length,
      precedentsPreview: precedents.slice(0, 3).map((p) => p.event),
    });

    const step0Result: Step0Result = {
      wildTranslations: parsed.wildTranslations ?? [],
      blackAtoms: parsed.blackAtoms ?? [],
      attackCandidates: parsed.attackCandidates ?? [],
      precedents,
    };
    if (!Array.isArray(step0Result.blackAtoms) || !Array.isArray(step0Result.attackCandidates)) {
      throw new Error("Invalid Step 0 JSON: missing blackAtoms or attackCandidates");
    }
    if (Object.keys(webContextMap).length > 0 && precedents.length === 0) {
      throw new Error(
        "Invalid Step 0 JSON: webContextMap 非空（宿主 AI 已执行联网搜索）但 precedents 为空。" +
        "类似先例检索是 Step 0 的强制步骤（④），请在 JSON 中补充 precedents 字段后重新提交。"
      );
    }

    const localFindings = state.orchestrationPreAuditContext?.localFindings ?? [];
    const stripped = state.orchestrationPreAuditContext?.stripped ?? stripContext(state.content);

    // Check if we have an LLM caller (Direct API / Sampling mode)
    const caller = resolveSystemAuditCaller(samplingFn);
    if (caller) {
      // Direct API / Sampling mode: run Steps 1-9 internally
      const timingFinding = localFindings.find((f) => f.timingDescription);
      const timingContext = timingFinding?.timingDescription as string | undefined;

      const preAuditReport = await executeLlmSystemAudit(
        state.content,
        systemAuditors,
        localFindings,
        caller,
        step0Result,
        webContextMap,
        precedents,
        timingContext,
        undefined, // sendProgress not available in orchestration path
      );
      state.preAuditReport = preAuditReport;
      state.systemAuditorIds = systemAuditors.map((a) => a.meta.id);
      state.step = state.tier === "pro" ? "rstConfirmation" : "checkPersonaInventory";
      await saveState(tmpDir, state);
      if (state.step === "rstConfirmation") {
        const prompts = await resolvePromptSegments();
        return toolResponse(
          state,
          [
            buildPreAuditSummaryBlock(state, prompts),
            "",
            "六维初审已完成。是否继续进行 RST 仿真评审，让虚拟读者基于上述风险点模拟真实反应？",
            "",
            "回复「继续」或「是」进入评审，回复「否」结束。",
          ].join("\n"),
        );
      }
      return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
    }

    // Orchestration mode: build context and emit Turn 2 audit prompt
    state.orchestrationPreAuditContext = buildOrchestrationPreAuditContext(
      state.content,
      localFindings,
      step0Result,
      webContextMap,
      precedents,
    );
    state.orchestrationPreAuditContext.stripped = stripped;
    state.step = "waitingForOrchestrationAudit";
    await saveState(tmpDir, state);

    return toolResponse(
      state,
      ORCHESTRATION_AUDIT_GUIDANCE +
        buildOrchestrationAuditPrompt(state.content, systemAuditors, state.orchestrationPreAuditContext),
    );
  } catch (err) {
    const info = getErrorInfo(err);
    await rollbackState(tmpDir, state.sessionId);
    return toolResponse(
      state,
      [
        "❌ 无法解析宿主 AI 返回的 Turn 1 JSON。",
        `错误：${info.message}`,
        "请让宿主 AI 仅返回包含 blackAtoms、attackCandidates 和可选 webContextMap 的合法 JSON，然后再次提交。",
      ].join("\n"),
    );
  }
}

function resolveSystemAuditCaller(samplingFn?: MultiTurnSamplingFunction): AuditLlmCaller | undefined {
  if (samplingFn) return samplingFn;
  if (!hasApiKey()) return undefined;
  return async (params) => {
    const response = await callConfiguredDirectApi({
      model: process.env.KEVLAR_MODEL || "",
      system: params.systemPrompt,
      messages: params.messages.map((message) => ({ role: "user", content: message.content })),
      maxTokens: params.maxTokens,
      temperature: 0.2,
    });
    return { content: response.content, stopReason: response.stopReason };
  };
}

async function executeLlmSystemAudit(
  content: string,
  systemAuditors: Persona[],
  localFindings: any[],
  caller: AuditLlmCaller,
  step0Result: Step0Result | undefined,
  webContextMap: Record<string, string>,
  precedents?: Precedent[],
  timingContext?: string,
  sendProgress?: (message: string) => void,
): Promise<PreAuditReport> {
  const prompts = await resolvePromptSegments();
  return executeFullPipeline(
    content,
    systemAuditors,
    localFindings,
    caller,
    step0Result,
    webContextMap,
    precedents,
    timingContext,
    sendProgress,
    prompts,
  );
}

async function handleOrchestrationAuditResult(
  tmpDir: string,
  state: ReviewWizardState,
  userPersonas: Persona[],
  systemAuditors: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  try {
    const parsed = JSON.parse(stripCodeFence(userMessage.trim()));
    const localFindings = state.orchestrationPreAuditContext?.localFindings ?? [];

    // Step 5: code-layer deterministic merge
    const mergedDimensions = normalizePreAuditDimensions(
      mergeLocalFindingsIntoAudits(normalizePreAuditDimensions(parsed.dimensions, systemAuditors), localFindings),
      systemAuditors,
    );

    // Step 7: code-layer deterministic synergy calculation
    const dimensionLevels: Record<string, string> = {};
    for (const dim of mergedDimensions) {
      dimensionLevels[dim.id] = dim.level ?? "🟢";
    }
    const timingFlag = localFindings.some((f: any) => f.timingWindowId) ? ["timing_risk"] : [];
    const synergyResult = calculateSynergy(dimensionLevels, timingFlag);

    // Extract deltaRisks from Turn 2 (with fallback)
    const deltaRisks = parsed.deltaRisks ?? buildEmptyDeltaRisks();

    // Store Turn 2 results for Turn 3
    state.orchestrationTurn2Results = {
      mergedDimensions,
      synergyResult,
      deltaRisks,
    };
    state.step = "waitingForOrchestrationFinal";
    await saveState(tmpDir, state);

    logger.info("Orchestration Turn 2 processed, emitting Turn 3 prompt", {
      event: "orchestration_turn2_processed",
      dimensionCount: mergedDimensions.length,
      synergyTriggered: synergyResult.triggered.length > 0,
    });

    const prompts = await resolvePromptSegments();

    // Emit Turn 3 prompt with code-layer deterministic results injected
    const turn3Prompt = buildOrchestrationFinalizerPrompt(
      state.content,
      systemAuditors,
      mergedDimensions,
      synergyResult,
      deltaRisks,
      state.orchestrationPreAuditContext?.precedents,
      prompts,
    );

    return toolResponse(state, ORCHESTRATION_FINAL_GUIDANCE + turn3Prompt);
  } catch (err) {
    const info = getErrorInfo(err);
    await rollbackState(tmpDir, state.sessionId);
    return toolResponse(
      state,
      [
        "❌ 无法解析宿主 AI 返回的 Turn 2 审计 JSON。",
        `错误：${info.message}`,
        "请让宿主 AI 仅返回包含 dimensions 和 deltaRisks 的合法 JSON，不要包含 Markdown 或解释文字，然后再次提交。",
      ].join("\n"),
    );
  }
}

/**
 * Handle Orchestration Turn 3: cross-validation + final arbitration result.
 */
async function handleOrchestrationFinalResult(
  tmpDir: string,
  state: ReviewWizardState,
  userPersonas: Persona[],
  systemAuditors: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  try {
    const parsed = JSON.parse(stripCodeFence(userMessage.trim()));
    const turn2 = state.orchestrationTurn2Results;

    if (!turn2) {
      throw new Error("Missing Turn 2 intermediate results (orchestrationTurn2Results)");
    }

    // Build final report from Turn 3 output + code-layer deterministic results
    const finalDimensions = normalizePreAuditDimensions(parsed.dimensions ?? turn2.mergedDimensions, systemAuditors);

    // Apply synergy level upgrades (code-layer guarantee)
    if (turn2.synergyResult.levelUpgrades.length > 0) {
      for (const upgrade of turn2.synergyResult.levelUpgrades) {
        const dim = finalDimensions.find((d) => d.id === upgrade.dimension);
        if (dim && dim.level === upgrade.from) {
          dim.level = upgrade.to;
        }
      }
    }

    const report: PreAuditReport = {
      dimensions: finalDimensions,
      summary: parsed.summary || summarizePreAuditResults(finalDimensions),
      riskProfile: parsed.riskProfile ?? undefined,
      synergyFlags: {
        triggered: turn2.synergyResult.triggered,
        overallMultiplier: turn2.synergyResult.overallMultiplier,
      },
      attackChainAnalysis: parsed.attackChainAnalysis ?? undefined,
      worstCaseNarrative: parsed.worstCaseNarrative ?? undefined,
      deltaRisks: turn2.deltaRisks,
      // 优先使用 Turn 1 保存在 context 里的先例（权威来源）。
      // parsed.precedents 来自宿主 AI 的 Turn 3 JSON 输出，若其返回空数组 [] 会覆盖
      // 真实先例，因此只在 context 为空时才回退到 parsed 的值。
      precedents:
        (state.orchestrationPreAuditContext?.precedents ?? []).length > 0
          ? state.orchestrationPreAuditContext?.precedents
          : (parsed.precedents ?? []),
    };

    logger.info("Orchestration Turn 3 processed, pre-audit complete", {
      event: "orchestration_turn3_processed",
      dimensionCount: finalDimensions.length,
      precedentsCount: (report.precedents ?? []).length,
      precedentsSource: parsed.precedents ? "parsed_from_host" : "fallback_to_context",
    });

    state.preAuditReport = report;
    state.orchestrationPreAuditContext = undefined;
    state.orchestrationTurn2Results = undefined;
    state.step = state.tier === "pro" ? "rstConfirmation" : "checkPersonaInventory";
    await saveState(tmpDir, state);

    if (state.step === "rstConfirmation") {
      const prompts = await resolvePromptSegments();
      return toolResponse(
        state,
        [
          buildPreAuditSummaryBlock(state, prompts),
          "",
          "六维初审已完成。是否继续进行 RST 仿真评审，让虚拟读者基于上述风险点模拟真实反应？",
          "",
          "回复「继续」或「是」进入评审，回复「否」结束。",
        ].join("\n"),
      );
    }
    return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
  } catch (err) {
    const info = getErrorInfo(err);
    await rollbackState(tmpDir, state.sessionId);
    return toolResponse(
      state,
      [
        "❌ 无法解析宿主 AI 返回的 Turn 3 最终仲裁 JSON。",
        `错误：${info.message}`,
        "请让宿主 AI 仅返回包含 dimensions、summary、worstCaseNarrative 的合法 JSON，然后再次提交。",
      ].join("\n"),
    );
  }
}

async function buildLocalRuleFindings(skillsDir: string, content: string): Promise<any[]> {
  const repo = new LocalJsonRuleRepository(skillsDir);
  const loaded = await repo.loadRules();
  if (!loaded) return [];

  const findings: any[] = [];

  // ── 0.1 时机节点检测 ───────────────────────────────────────────────────
  // L1 本地层仅标记命中，不决定风险等级（由 LLM L2 层判定）
  const timingFinding = repo.checkTimingRisk(new Date(), content);
  if (timingFinding) {
    findings.push({
      dimension: "时机风险",
      keyword: timingFinding.windowLabel,
      trigger: `时机窗口命中：${timingFinding.windowLabel}`,
      riskDescription: timingFinding.description,
      propagationRisk: `窗口期内风险系数 ${timingFinding.riskMultiplier}x，建议关注舆论放大效应。`,
      source: "local_rule_engine",
      timingWindowId: timingFinding.windowId,
      timingMultiplier: timingFinding.riskMultiplier,
      timingDescription: timingFinding.description,
    });
  }
  const seen = new Set<string>();

  // ── 0.2 2-4 gram 滑动窗口匹配 ──────────────────────────────────────────
  const candidates = extractAuditCandidates(content);

  for (const candidate of candidates) {
    const matches = repo.resolveVariant(candidate);
    for (const match of matches) {
      const key = `${candidate}::${match.rule.root}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const contextTerms = findContextRiskTerms(content, candidate);
      const level = contextTerms.length >= 2 || match.rule.severity === "HIGH" ? "🔴" : "🟡";
      findings.push({
        dimension: "网络文化误读",
        keyword: candidate,
        trigger: `本地规则命中：${candidate} -> ${match.rule.root}`,
        riskDescription: [
          `词根：${match.rule.root}`,
          `风险方向：${match.rule.misinterpret_direction}`,
          contextTerms.length > 0
            ? `邻近高风险修饰：${contextTerms.join("、")}`
            : "未发现明显邻近修饰，但仍需检查语境是否为正常食材/花草表达",
        ].join("；"),
        propagationRisk: "容易被截取为颜色/身体化暗示或低俗黑话，造成评论区恶意联想。",
        suggestedLevel: level,
        suggestion: match.rule.suggestion,
        source: "local_rule_engine",
        root: match.rule.root,
      });
    }
  }

  // ── 0.3 L2 结构模式检测 ────────────────────────────────────────────────
  const structuralMatches = repo.checkStructuralPatterns(content);
  for (const sm of structuralMatches) {
    const key = `struct::${sm.patternId}::${sm.windowStart}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const matchedWordsStr = sm.matchedWords.map((m) => m.word).join("、");
    findings.push({
      dimension: "低俗擦边风险",
      keyword: matchedWordsStr,
      trigger: `语义类别组合命中：${sm.patternId}`,
      riskDescription: [
        `风险类型：${sm.riskType}`,
        `命中词：${matchedWordsStr}`,
        `位置范围：${sm.windowStart}-${sm.windowEnd}`,
      ].join("；"),
      propagationRisk: "多类别语义词在同一窗口内堆叠，容易被截图后进行颜色/身体向解读。",
      suggestedLevel: sm.suggestedLevel,
      source: "local_rule_engine",
      patternId: sm.patternId,
    });
  }

  // ── 0.4 Multi-hop patterns 检测 ────────────────────────────────────────
  const multiHopMatches = repo.checkMultiHopPatterns(content);
  for (const mhm of multiHopMatches) {
    const key = `multihop::${mhm.category}::${mhm.pattern.join("-")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    findings.push({
      dimension: "网络文化误读",
      keyword: mhm.matchedWords.join(" + "),
      trigger: `多跳模式匹配 [${mhm.category}]：${mhm.pattern.join(" -> ")}`,
      riskDescription: `检测到高关联度敏感词分散组合风险，潜在风险类型为: ${mhm.risk}。`,
      propagationRisk: "词汇在文本中分散出现，可能被防不胜防地联想并合并解读。",
      suggestedLevel: "🟡",
      source: "local_rule_engine",
    });
  }

  // 注意：时机窗口命中时的风险等级升级由 LLM 仲裁层（finalizePreAuditReport）决定，
  // L1 本地层仅输出原始 findings，不自行定级。
  return findings;
}

function extractAuditCandidates(content: string): string[] {
  const normalized = content.replace(/[\s,，。！？；;：:、"'""''()[\]{}<>《》|/\\-]+/g, "");
  const candidates = new Set<string>();
  for (let size = 2; size <= 4; size++) {
    for (let i = 0; i <= normalized.length - size; i++) {
      candidates.add(normalized.slice(i, i + size));
    }
  }
  return [...candidates];
}

function findContextRiskTerms(content: string, keyword: string): string[] {
  const riskTerms = ["贵妇", "粉嫩", "粉", "肥厚", "柔软", "嫩", "鲜嫩", "爆", "黑", "白", "红"];
  const keywordIndex = content.indexOf(keyword);
  const context =
    keywordIndex >= 0 ? content.slice(Math.max(0, keywordIndex - 12), keywordIndex + keyword.length + 24) : content;
  return riskTerms.filter((term) => context.includes(term));
}

const CHINESE_DIMENSION_NAMES: Record<string, string> = {
  legal_compliance: "合规",
  context_distortion: "语境脱嵌",
  network_culture_risk: "网络文化",
  factual_integrity: "事实",
  social_risk: "社会风险",
  cross_lingual_distortion: "跨语言曲解",
  local_rule_engine: "本地规则",
};

function formatRiskyAuditorName(result: { id?: string; name: string }): string {
  const dimensionName = result.id ? CHINESE_DIMENSION_NAMES[result.id] : undefined;
  return dimensionName ? `${result.name}（${dimensionName}）` : result.name;
}

function escapeMarkdownTableCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatPreAuditTable(clean: Array<{ name: string; id?: string }>): string[] {
  if (clean.length === 0) return [];
  return [
    "| 审查维度 | 结果 |",
    "| --- | --- |",
    ...clean.map((r) => `| ${escapeMarkdownTableCell(r.name)} | ✅ 通过 |`),
  ];
}

function formatFindingRiskLine(finding: any): string {
  const keyword = finding.keyword
    ? `「${finding.keyword}」`
    : finding.dimension
      ? `「${finding.dimension}」`
      : "该内容";
  const parts = [
    finding.root ? `词根为"${finding.root}"` : undefined,
    finding.trigger,
    finding.riskDescription || finding.description,
    finding.propagationRisk,
  ].filter(Boolean);
  const detail = parts.length > 0 ? parts.join("；") : "存在潜在语义或传播风险，建议进入复审确认。";
  return `发现 1 项潜在风险：${keyword} ${detail}`;
}

function formatRiskSection(result: { id?: string; name: string; findings: any[] }): string[] {
  return [
    `⚠️ 风险预警（${formatRiskyAuditorName(result)}）`,
    ...(result.findings || []).map((finding) => formatFindingRiskLine(finding)),
  ];
}

function getOverallLevel(results: Array<{ level?: string; findings: any[] }>): string {
  let hasYellow = false;
  for (const r of results) {
    const l = r.level || getFindingsLevel(r.findings);
    if (l === "🔴") return "🔴 红色高危";
    if (l === "🟡") hasYellow = true;
  }
  return hasYellow ? "🟡 黄色预警" : "🟢 绿色安全";
}

function summarizePreAuditResults(
  results: Array<{ id?: string; name: string; findings: any[]; level?: string }>,
): string {
  if (results.length === 0) return "本地规则与系统审查员均未命中风险点";

  const risky: Array<{ name: string; findings: any[]; id?: string; level?: string }> = [];

  for (const r of results) {
    if (r.findings && r.findings.length > 0) {
      risky.push(r);
    }
  }

  const overallLevel = getOverallLevel(results);

  // 全部通过
  if (risky.length === 0) {
    return [
      `综合风险等级：${overallLevel}`,
      "扫描结果（表格）：",
      "| 维度 | 等级 | 关键发现 |",
      "| --- | --- | --- |",
      ...results.map((r) => `| ${escapeMarkdownTableCell(r.name)} | 🟢 | 无 |`),
    ].join("\n");
  }

  // 有风险维度
  const riskSummaryLines = results.map((r) => {
    const level = r.level || getFindingsLevel(r.findings);
    const riskKeywords =
      r.findings.length > 0
        ? r.findings
            .map((f) => f.keyword || f.trigger)
            .filter(Boolean)
            .join("、")
        : "无";
    return `| ${escapeMarkdownTableCell(r.name)} | ${level} | ${escapeMarkdownTableCell(riskKeywords)} |`;
  });

  return [
    `综合风险等级：${overallLevel}`,
    "扫描结果（表格）：",
    "| 维度 | 等级 | 关键发现 |",
    "| --- | --- | --- |",
    ...riskSummaryLines,
  ].join("\n");
}

// ── 辅助：构建初审结果展示块 ─────────────────────────────────────────────────

function buildPreAuditSummaryBlock(state: ReviewWizardState, prompts?: PromptSegments): string {
  const segs = prompts ?? loadPromptSegments("free");
  const lines: string[] = ["<!-- kevlar:verbatim-pre-audit:start -->", "初审结果"];
  if (state.preAuditReport?.summary) {
    lines.push(state.preAuditReport.summary);
  } else {
    lines.push("", "未找到系统审查员，跳过初审");
  }

  // 类似先例：始终渲染此段（无则输出"无"），保证链路完整
  if (state.preAuditReport) {
    const precedents = state.preAuditReport.precedents;
    lines.push("");
    lines.push(`${segs.precedentSectionHeader}：`);
    if (isPro()) {
      if (precedents && precedents.length > 0) {
        for (const p of precedents) {
          lines.push(`• ${p.event}${p.date ? `（${p.date}）` : ""}`);
        }
      } else {
        lines.push(segs.precedentNoneMessage);
      }
    } else {
      lines.push(segs.precedentLockedMessage);
    }
  }

  lines.push("<!-- kevlar:verbatim-pre-audit:end -->");
  return lines.join("\n");
}


// ── 初审完成：展示结果并询问是否复审 ─────────────────────────────────────────
//
// 改造说明（原 handleInventoryCheck）：
// 原版把初审结果、评审员推荐、"开始复审"邀请混在同一条消息里。
// 改造后只展示初审结果 + 询问"是否需要复审"，step 置为 waitingForReviewDecision。
// 评审员推荐逻辑移至 handleReviewDecision，用户确认后才执行。

async function handleInventoryCheck(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  const prompts = await resolvePromptSegments();
  const upgradeHint = state.tier === "free" ? "\n\n" + prompts.freeTierUpgradeHint : "";

  // 无评审员：提示创建，流程暂停
  if (personas.length === 0) {
    state.step = "waitingForPersonaCreation";
    state.selectedPersonaIds = [];
    state.remainingPersonaIds = [];
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        buildPreAuditSummaryBlock(state, prompts),
        "",
        "当前还没有可用评审员。请先创建至少一个角色，再继续这次内容评测。",
        "",
        "我已经暂存了本次待评测内容；创建角色后，带上这个 sessionId 再次调用 review_content_wizard 即可继续。",
        upgradeHint,
      ].join("\n"),
    );
  }

  // 有评审员：展示初审结果，询问下一步
  state.step = "waitingForReviewDecision";
  await saveState(tmpDir, state);
  return toolResponse(
    state,
    [
      buildPreAuditSummaryBlock(state, prompts),
      "",
      "请选择下一步：",
      "1. 进入「复审」",
      "2. 模拟平台违禁限流排查",
      upgradeHint,
    ].join("\n"),
  );
}

// ── 用户决定是否复审 ──────────────────────────────────────────────────────────

async function handleReviewDecision(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  const normalized = userMessage.trim();

  // 选项 2：模拟平台违禁限流排查（即将开放）
  if (/^(2|模拟平台违禁限流排查|合规检查|平台检查|平台违禁限流排查|违禁限流排查)$/i.test(normalized)) {
    return toolResponse(
      state,
      [
        "该功能正在开发中，敬请期待。",
        "",
        "请选择下一步：",
        "1. 进入「复审」",
        "2. 模拟平台违禁限流排查",
      ].join("\n"),
    );
  }

  // 选项 1：进入复审
  const wantsReview = /^(1|需要|开始复审|确认复审|执行复审|继续|好的|好|ok|yes|进入复审|复审|进入「复审」)$/i.test(normalized);

  if (!wantsReview) {
    return toolResponse(
      state,
      [
        "请选择下一步：",
        "1. 进入「复审」",
        "2. 模拟平台违禁限流排查",
      ].join("\n"),
    );
  }

  // 用户确认复审：执行评审员推荐
  // 仅 1-2 位评审员：直接全选
  if (personas.length <= 2) {
    state.selectedPersonaIds = [...personas.map((p) => p.meta.id)];
    state.remainingPersonaIds = [];
    state.step = "waitingForReviewerConfirmation";
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        `当前共有 ${personas.length} 位评审员，已全部选中：`,
        "",
        ...personas.map(
          (p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.tags.join("、") || "通用"} · ${p.meta.description}`,
        ),
        "",
        "请回复「开始复审」确认执行，或回复「X 换一位」替换指定评审员（例如：2 换一位）。",
      ].join("\n"),
    );
  }

  // 3 位及以上：AI 推荐 1-3 位
  const recommendation = await recommendPersonas(state, personas, samplingFn);
  const recommendedIds = new Set(recommendation.personaIds);

  state.selectedPersonaIds = [...recommendation.personaIds];
  state.remainingPersonaIds = personas.filter((p) => !recommendedIds.has(p.meta.id)).map((p) => p.meta.id);
  state.step = "waitingForReviewerConfirmation";
  await saveState(tmpDir, state);

  const remainingPersonas = personas.filter((p) => !recommendedIds.has(p.meta.id));
  return toolResponse(
    state,
    [
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
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

// ── 等待用户确认评审员 ────────────────────────────────────────────────────────

async function handleReviewerConfirmation(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  const normalized = userMessage.trim();

  // Parse "X 换一位"
  const swapMatch = normalized.match(/^(\d+)\s*换一位$/);
  if (swapMatch) {
    const idx = parseInt(swapMatch[1], 10);
    return handleSwapReviewer(tmpDir, state, personas, idx);
  }

  // "开始复审" → 直接执行完整复审
  if (/^(开始复审|确认复审|执行复审)$/.test(normalized)) {
    if (state.selectedPersonaIds.length === 0) {
      return toolResponse(state, "❌ 当前没有已选择的复审评审员。请先通过「X 换一位」选择评审员后再试。");
    }
    return executeReview(skillsDir, tmpDir, state, samplingFn);
  }

  // 未识别 → 重新展示当前评审员状态
  await saveState(tmpDir, state);
  const selectedUserPersonas = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
  const remaining = personas.filter((p) => state.remainingPersonaIds.includes(p.meta.id));
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
    ].join("\n"),
  );
}

async function handleSwapReviewer(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  position: number,
): Promise<ToolResult> {
  if (position < 1 || position > state.selectedPersonaIds.length) {
    const selected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
    return toolResponse(
      state,
      [
        `❌ 编号 ${position} 超出范围。当前已选复审评审员：`,
        ...selected.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
        "",
        "请重新输入正确的编号。",
      ].join("\n"),
    );
  }

  // 备选池为空
  if (state.remainingPersonaIds.length === 0) {
    const selected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
    return toolResponse(
      state,
      [
        "⚠️ 备选池已没有可替换的评审员。",
        "",
        "当前已选复审评审员：",
        ...selected.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
        "",
        "请回复「开始复审」确认执行。",
      ].join("\n"),
    );
  }

  const removedId = state.selectedPersonaIds[position - 1];
  const removedPersona = personas.find((p) => p.meta.id === removedId);

  const addedId = state.remainingPersonaIds.shift()!;
  state.selectedPersonaIds = state.selectedPersonaIds.filter((id) => id !== removedId);
  state.selectedPersonaIds.push(addedId);
  state.remainingPersonaIds.push(removedId);

  state.step = "waitingForReviewerConfirmation";
  await saveState(tmpDir, state);

  const updatedSelected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
  const remaining = personas.filter((p) => state.remainingPersonaIds.includes(p.meta.id));
  const addedPersona = personas.find((p) => p.meta.id === addedId);

  return toolResponse(
    state,
    [
      `✅ 已替换：${removedPersona?.meta.name || "未知"} → ${addedPersona?.meta.name || "未知"}`,
      "",
      "当前已选复审评审员：",
      ...updatedSelected.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
      "",
      ...(remaining.length > 0 ? [`备选评审员（共 ${remaining.length} 位）`] : []),
      "请回复「开始复审」确认执行，或回复「X 换一位」继续替换。",
    ].join("\n"),
  );
}

async function recommendPersonas(
  state: ReviewWizardState,
  personas: Persona[],
  samplingFn?: MultiTurnSamplingFunction,
): Promise<Recommendation> {
  // First try RST-based recommendation for RST-configured personas
  const rstRecommendation = recommendRSTPersonas(
    state.content,
    state.preAuditReport,
    personas,
    state.context || undefined,
  );

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
          '你是评审员推荐助手。根据待评测内容和系统初审报告推荐 1-3 个最匹配的评审员，输出 JSON：{"personaIds":["id"],"assistantMessage":"推荐理由"}。assistantMessage 应包含「根据内容特色和初审发现的风险点，为您推荐了 X 位合适的评审员」及每位推荐评审员的简要理由。不要输出 markdown。',
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
        ? parsed.personaIds
            .map(String)
            .filter((id) => validIds.has(id))
            .slice(0, 3)
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

async function handleRstConfirmation(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  const normalized = userMessage.trim().toLowerCase();
  const wantsRst = /^(是|继续|确认|好的|好|yes|y|1|开始|开始复审|进入复审|继续评审|继续 RST|继续rst)$/i.test(normalized);

  if (wantsRst) {
    state.step = "checkPersonaInventory";
    await saveState(tmpDir, state);
    // Pre-audit results are in state.preAuditReport; they flow into
    // Focus Topics when RST runs via handleInventoryCheck → executeReview.
    return handleInventoryCheck(tmpDir, state, personas, samplingFn);
  }

  const wantsSkip = /^(否|不|取消|跳过|不用|不需要|结束|退出|skip|no|n|2)$/i.test(normalized);
  if (wantsSkip) {
    state.step = "completed";
    await saveState(tmpDir, state);
    return toolResponse(state, "评测已完成，未进入 RST 仿真评审。需要评测新内容时，请重新开始。");
  }

  return toolResponse(
    state,
    [
      "六维初审已完成。是否继续进行 RST 仿真评审，让虚拟读者基于上述风险点模拟真实反应？",
      "",
      "回复「继续」或「是」进入评审，回复「否」结束。",
    ].join("\n"),
  );
}

async function executeReview(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  samplingFn?: MultiTurnSamplingFunction,
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
    tier: state.tier as "free" | "pro" | undefined,
    runContext: state.strategySessionId
      ? {
          reviewRunId: `wizard-${state.sessionId}`,
          strategySessionId: state.strategySessionId,
          strategyVersion: "1.0.0",
          strategyHash: state.strategyHash ?? "",
          promptSetHash: state.strategyHash ?? "",
          weightSetHash: state.strategyHash ?? "",
          executionMode: "orchestration",
          locale: "zh-CN",
          startedAt: new Date().toISOString(),
        }
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
  const upgradePrompt =
    state.tier === "free"
      ? "\n\n---\n\n" + (await resolvePromptSegments()).freeTierUpgradePrompt
      : "";
  const response = toolResponse(state, resultText + "\n\n---\n\n评测完成。" + upgradePrompt);
  await cleanupState(tmpDir, state.sessionId);
  return response;
}

async function loadOrCreateState(tmpDir: string, input: ReviewWizardInput): Promise<ReviewWizardState> {
  if (input.sessionId && !isValidSessionId(input.sessionId)) {
    throw new Error("sessionId 格式不合法。");
  }

  const sessionId = input.sessionId || `wizard-review-${Math.random().toString(36).substring(2, 10)}`;
  const statePath = getStatePath(tmpDir, sessionId);

  if (input.sessionId && fs.existsSync(statePath)) {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    const state = JSON.parse(raw) as ReviewWizardState;
    if (!state.dimensions) {
      state.dimensions = { ...DEFAULT_DIMENSIONS_CONFIG };
    }
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
    tier: undefined,
    strategySessionId: undefined,
    strategyHash: undefined,
  };
}

async function saveState(tmpDir: string, state: ReviewWizardState, backup = true): Promise<void> {
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const statePath = getStatePath(tmpDir, state.sessionId);

  // Create backup before overwriting (MECP §6.3 state rollback)
  if (backup && fs.existsSync(statePath)) {
    try {
      await fs.promises.copyFile(statePath, statePath + ".bak");
    } catch {
      // non-fatal: best-effort backup
    }
  }

  const tmpPath = statePath + ".tmp";
  await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  await fs.promises.rename(tmpPath, statePath);
}

/** Rollback wizard state to last backup (MECP §6.3). */
async function rollbackState(tmpDir: string, sessionId: string): Promise<boolean> {
  const statePath = getStatePath(tmpDir, sessionId);
  const bakPath = statePath + ".bak";
  if (!fs.existsSync(bakPath)) return false;
  try {
    await fs.promises.copyFile(bakPath, statePath);
    return true;
  } catch {
    return false;
  }
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
          `dimensions: defensive=${DEFENSIVE_DIMENSION_IDS.length}(system), offensive=${state.dimensions.offensive.length}`,
          "```",
        ].join("\n"),
      },
    ],
  };
}

function stripCodeFence(text: string): string {
  if (!text.startsWith("```")) return text;
  return text
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}
