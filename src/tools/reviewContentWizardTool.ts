import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import { MultiTurnSamplingFunction, ExecutionMode } from "../execution/base.js";
import { loadAllPersonas, Persona } from "../utils/parser.js";
import {
  DEFAULT_DIMENSIONS_CONFIG,
  DEFENSIVE_DIMENSION_IDS,
  type DimensionsConfig,
  buildDefensiveSystemDirective,
  buildOffensiveSystemDirective,
  buildPersonaContextDirective,
  buildToneDirective,
  buildReviewUserMessage,
  DIMENSIONS,
} from "../execution/dimensions.js";
import { recommendRSTPersonas } from "../execution/rstRecommender.js";
import { logger, getErrorInfo } from "../utils/observability.js";
import { formatErrorWithReportPrompt } from "../utils/errorReporting.js";
import JSON5 from "json5";
import { isValidSessionId } from "../utils/sessionId.js";
import { invalidInputError, validationError, internalError } from "../utils/errors.js";
import type { ToolModule } from "./types.js";
import { RuleRepository } from "../dao/RuleRepository.js";
import { isPro } from "../subscription/tier.js";
import { readConfig, isValidMode } from "../execution/config.js";
import { SaaSClient } from "../utils/saasClient.js";
import { checkForUpdate } from "./checkUpdateTool.js";
import { type PromptSegments } from "../subscription/promptTypes.js";
import { loadPromptSegments } from "../subscription/promptTemplates.js";
import type { StrategyProvider, ReviewPlan } from "../execution/strategy.js";
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
import { isSamplingSupported } from "../execution/client.js";
import { validateReceipt, fallbackToStandardOrchestration } from "../execution/protocol.js";
import {
  resolveExecutionPlan,
  type ExecutionPlan,
  type AuditCheckpoint,
  type DispatchFailureReason,
  type ExecutionTransition,
  type AgentBlueprint,
  type AgentDefinition,
} from "../execution/index.js";
import { classifyHostStructuredResult, isKevlarHostGuidedResult, getClientFingerprint } from "../execution/client.js";
import type { ClientFingerprint } from "../execution/plan.js";
import { recordCapabilityObservation, inferTaskClass } from "../execution/observations.js";
import {
  type AuditLlmCaller,
  type PreAuditDimensionResult,
  type PreAuditReport,
  getFindingsLevel,
  buildEmptyDeltaRisks,
  normalizePreAuditDimensions,
  mergeLocalFindingsIntoAudits,
  computeDeltaAnalysis,
  crossValidateRiskyDimensions,
  finalizePreAuditReport,
  runSystemAuditors,
  executeFullPipeline,
} from "../execution/reviewSteps.js";


export const ORCHESTRATION_STEP0_GUIDANCE = [
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

export const ORCHESTRATION_AUDIT_GUIDANCE = [
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
        description: "会话ID。首次调用时留空（工具自动生成并返回）。后续每一步必须传入相同的 sessionId，否则工具会创建新会话丢失原文！",
      },
      userMessage: {
        type: "string",
        description:
          "用户当前输入内容。首次调用时传入待评测的完整文本或评测请求；后续交互时传入用户指令（如「开始舆论仿真推演」或「2 换一位」）。必须为纯文本。",
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
  | "waitingForRegionSelection" // 新：询问目标推广地区（Free/Pro 通用）
  | "systemAudit"
  | "waitingForOrchestrationStep0" // 宿主编排 Turn 1: 等待 Step 0 JSON
  | "waitingForOrchestrationAudit" // 宿主编排 Turn 2: 等待维度审计 JSON
  | "waitingForOrchestrationFinal" // 宿主编排 Turn 3: 等待交叉验证 + 最终仲裁 JSON
  | "waitingForSubagentAudit" // Subagent 并行调度：等待 subagent 审计结果
  | "waitingForPersonaAudit" // Stage 2 Subagent 并行：等待 persona 评审结果
  | "checkPersonaInventory"
  | "waitingForPersonaCreation"
  | "waitingForReviewDecision"
  | "waitingForReviewerConfirmation"
  | "waitingForNextRound"
  | "rstConfirmation"
  | "completed";

interface ReviewWizardState {
  sessionId: string;
  createdAt: number;
  step: ReviewWizardStep;
  mode?: ExecutionMode;
  // v3: New execution plan system
  executionPlan?: ExecutionPlan;
  checkpoint?: AuditCheckpoint;
  structuredDowngraded?: boolean;
  capabilityStatus?: import("../execution/plan.js").HostStructuredCapabilityStatus;
  executionTransitions?: import("../execution/checkpoint.js").ExecutionTransition[];
  // v3: Continuation contract fields
  revision?: number;
  activeContinuation?: {
    continuationId: string;
    checkpoint: import("../execution/checkpoint.js").AuditCheckpoint;
    expiresAt: number;
    retryCount: number;  // 0-based, incremented each time Host AI resubmits
  };
  content: string;
  context?: string;
  targetPlatforms: string[];
  selectedPersonaIds: string[];
  remainingPersonaIds: string[];
  systemAuditorIds: string[];
  dimensions: DimensionsConfig;
  usedPersonaIds?: string[];  // 已参与过评审的人设 ID（用于"换一批"排除）
  pendingPersonaIds?: string[];  // 当前展示给用户的人设 ID 列表（按展示顺序）
  preAuditReport?: any;
  tier?: "free" | "pro";
  targetRegions?: string[];  // 推广目标地区 ["zh-CN", "en-US", ...]
  strategySessionId?: string;
  strategyHash?: string;
  // Pro: slot-based per-agent result tracking (003)
  agentSlots?: {
    total: number;
    received: Record<string, import("../execution/protocol.js").AgentSlotResult>;
  };
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
    if (!args) throw invalidInputError("向导需要提供参数");
    const input = args as any;
    input.samplingFn = deps.resolveSamplingFn();
    input.sendProgress = deps.sendProgress;
    input.strategyProvider = deps.strategyProvider;
    return await handleReviewContentWizard(deps.skillsDir, deps.tmpDir, input);
  },
};

// ── v3: Continuation Contract Helper ───────────────────────────────────────────

/**
 * Transition the wizard state to a new step and emit the required
 * state_transition log event for audit traceability (§6.3).
 */
function transitionState(
  state: ReviewWizardState,
  nextStep: ReviewWizardStep,
  reason: string,
): void {
  const prevStep: string = (state as any).step ?? "idle";
  state.step = nextStep;
  logger.info("State transition", {
    event: "state_transition",
    from: prevStep,
    to: nextStep,
    reason,
    sessionId: state.sessionId,
  });
}

/**
 * Set up a continuation contract on the wizard state.
 *
 * When Kevlar asks the Host to submit results (after Step 0, after audit,
 * after final), it emits a continuation contract containing a unique
 * continuationId and the current revision. The Host must pass these back
 * when calling review_content_wizard_continue to prevent stale submissions.
 */
function setContinuation(
  state: ReviewWizardState,
  step: ReviewWizardStep,
  checkpoint: AuditCheckpoint,
): void {
  // Map step to the checkpoint expected when the Host calls back
  const continuationId = `${state.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.revision = (state.revision ?? 0) + 1;
  state.activeContinuation = {
    continuationId,
    checkpoint,
    expiresAt: Date.now() + 30 * 60 * 1000, // 30 min timeout
    retryCount: 0,
  };
}

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
      state.tier = (process.env.KEVLAR_TIER as "free" | "pro") ?? plan.tier;
      state.strategySessionId = plan.strategySessionId;
      state.strategyHash = plan.strategyHash;

      // Resolve execution mode once for the session (v3: ExecutionPlan)
      if (state.mode === undefined && state.executionPlan === undefined) {
        // v3: Use ExecutionPlan-based resolution
        // host_orchestration+structured > host_orchestration+standard
        const planResult = resolveExecutionPlan({
          fingerprint: getClientFingerprint(),
          content: state.content,
        });

        // Store the execution plan (v3 structured type)
        state.executionPlan = planResult.plan;

        // Map plan back to legacy ExecutionMode for backward compat with existing wizard flows
        state.mode = planResult.legacyMode;

        // Initialize checkpoint tracking
        state.checkpoint = "initiated";
        state.structuredDowngraded = false;
        state.revision = state.revision ?? 1;
      } else if (state.checkpoint === undefined) {
        // Backward compat: existing wizard states that pre-date checkpoint tracking
        state.checkpoint = "initiated";
        state.structuredDowngraded = false;
      }
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

    // Free tier: skip system audit, go to persona selection
    if (isFreeTier && state.step === "systemAudit") {
      transitionState(state, "checkPersonaInventory", "free_tier_skip_preaudit");
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
      strategyProvider,
    );
  } catch (err) {
    const info = getErrorInfo(err);
    logger.error("Review content wizard failed", {
      event: "review_wizard_error",
      error: info.code,
      message: info.message,
    });
    return {
      content: [{
        type: "text",
        text: formatErrorWithReportPrompt(
          `❌ 内容评测向导失败：[${info.code}] ${info.message}`,
          "review_content_wizard",
        ),
      }],
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
  strategyProvider?: StrategyProvider,
): Promise<ToolResult> {
  switch (state.step) {
    case "waitingForRegionSelection": {
      const result = await handleRegionSelection(tmpDir, state, userMessage);
      // If step advanced, save and continue to next step in this same call
      if ((result as any).stepAdvanced) {
        await saveState(tmpDir, state);
        // Tail call: re-enter advanceWizard with the new step
        return advanceWizard(skillsDir, tmpDir, state, personas, systemAuditors, "", samplingFn, sendProgress, plan, strategyProvider);
      }
      return result;
    }

    case "systemAudit":
      // Free tier: skip pre-audit. state.tier resolved at init time (line 318).
      if (state.tier !== "pro" && process.env.KEVLAR_TIER !== "pro") {
        return handleInventoryCheck(tmpDir, state, personas, samplingFn);
      }
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
        sendProgress,
        strategyProvider,
      );

    case "waitingForSubagentAudit":
      return handleSubagentAuditResult(tmpDir, state, personas, systemAuditors, userMessage, samplingFn, strategyProvider);

    case "waitingForOrchestrationAudit":
      return handleOrchestrationAuditResult(tmpDir, state, personas, systemAuditors, userMessage, samplingFn, strategyProvider);

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

    case "waitingForPersonaAudit":
      return handlePersonaAuditResult(tmpDir, state, personas, userMessage, samplingFn);

    case "waitingForNextRound":
      return handleNextRound(tmpDir, state, personas, userMessage, samplingFn);

    case "completed":
      return toolResponse(state, "这个评测流程已经完成。需要评测新内容时，请重新开始一个会话。");

    default:
      return toolResponse(state, "未知步骤，请重新开始评测流程。");
  }
}

// ── 目标推广地区选择 ──────────────────────────────────────────────────────────

const REGION_MAP: Record<string, string> = {
  "中国": "zh-CN", "大陆": "zh-CN", "内地": "zh-CN", "zh-cn": "zh-CN", "cn": "zh-CN",
  "台湾": "zh-TW", "香港": "zh-HK", "澳门": "zh-MO",
  "美国": "en-US", "us": "en-US", "usa": "en-US", "en-us": "en-US",
  "英国": "en-GB", "uk": "en-GB", "gb": "en-GB",
  "日本": "ja-JP", "jp": "ja-JP", "ja-jp": "ja-JP",
  "韩国": "ko-KR", "kr": "ko-KR", "ko-kr": "ko-KR",
  "全球": "global", "通用": "global", "不限": "global",
};

function parseRegionInput(userMessage: string): string[] {
  const normalized = userMessage.toLowerCase().replace(/[，,、\s]+/g, ",");
  const parts = normalized.split(",").map(s => s.trim()).filter(Boolean);
  const regions = new Set<string>();

  for (const part of parts) {
    const code = REGION_MAP[part] || REGION_MAP[part.toLowerCase()];
    if (code) regions.add(code);
  }

  return [...regions];
}

async function handleRegionSelection(
  tmpDir: string,
  state: ReviewWizardState,
  userMessage: string,
): Promise<ToolResult> {
  // Detect if userMessage looks like region input (not the original content)
  const parsedRegions = parseRegionInput(userMessage);

  // Only accept as region input if EVERY segment is a valid region keyword
  const segments = userMessage.trim().split(/[，,、\s]+/).filter(Boolean);
  const allSegmentsValidRegions = segments.length > 0
    && userMessage.length < 100
    && segments.every(s => REGION_MAP[s] || REGION_MAP[s.toLowerCase()] !== undefined);
  const isRegionInput = parsedRegions.length > 0 && allSegmentsValidRegions;

  // First call: userMessage is content, no region keywords detected → ask
  if (!isRegionInput) {
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        "请告知本次内容计划推广的目标国家或地区，用逗号或空格分隔即可。",
        "",
        "例如：「中国、美国、日本」「全球」「大陆,台湾」",
        "",
        "（我会根据你指定的地区，加载相应的合规规则和文化敏感词库进行审核。）",
      ].join("\n"),
    );
  }

  // Accept region input (only when user explicitly provides region keywords)
  state.targetRegions = parsedRegions.length > 0 ? parsedRegions : ["global"];
  transitionState(state, "systemAudit", "region_selection_completed");
  return { stepAdvanced: true } as any;
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
  const localFindings = await buildRuleFindings(skillsDir, state.content, state.targetRegions);

  if (systemAuditors.length === 0) {
    const dimensions =
      localFindings.length > 0
        ? [
            {
              id: "local_rule_engine",
              name: "规则引擎",
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
          "六维风险检测已完成（规则模式）。是否继续进行舆论仿真推演？",
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
          "六维风险检测已完成（本地回退模式）。是否继续进行舆论仿真推演？",
          "",
          "回复「继续」或「是」进入评审，回复「否」结束。",
        ].join("\n"),
      );
    }
    return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
  }

  // ── Kevlar Execution Protocol v1 Blueprint Dispatch ────────────────────────
  const plan = state.executionPlan;
  if (plan?.backend === "host_orchestration" && plan.strategy === "structured") {
    // ── Step 0b FIRST: host AI performs global decoding + web search ──
    // In structured (mcp_subagent) mode, we send the Step 0b prompt
    // BEFORE dispatching the 6 dimension subagents. The host AI must
    // complete web search and global decoding first, then submit the
    // result. handleOrchestrationStep0Result() will fork: when it
    // detects structured strategy, it proceeds to build the AgentBlueprint
    // with step0Result/webContextMap injected into each subagent.
    const stripped = stripContext(state.content);
    state.orchestrationPreAuditContext = { localFindings, stripped };
    transitionState(state, "waitingForOrchestrationStep0", "structured_step0_web_search");
    setContinuation(state, "waitingForOrchestrationStep0", "step0_completed");
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      ORCHESTRATION_STEP0_GUIDANCE + buildOrchestrationStep0Prompt(state.content, localFindings, stripped),
    );
  }

  // Standard Fallback: host AI performs Step 0b (decoding) + web search
  const stripped = stripContext(state.content);
  transitionState(state, "waitingForOrchestrationStep0", "standard_orchestration_fallback");
  state.orchestrationPreAuditContext = { localFindings, stripped };
  setContinuation(state, "waitingForOrchestrationStep0", "step0_completed");
  await saveState(tmpDir, state);
  return toolResponse(
    state,
    ORCHESTRATION_STEP0_GUIDANCE + buildOrchestrationStep0Prompt(state.content, localFindings, stripped),
  );
}

/**
 * Render the blueprint dispatch text that instructs the Host AI to
 * spawn subagents for parallel dimension audits.
 *
 * Extracted from handleSystemAudit() so it can be reused from
 * handleOrchestrationStep0Result() in the structured (subagent) path
 * after Step 0b web search has been completed.
 */
function renderBlueprintDispatchText(
  state: ReviewWizardState,
  blueprint: AgentBlueprint,
): string {
  const isProTier = state.tier === "pro";

  const perAgentGuidance = isProTier
    ? [
        "",
        "### Pro option: submit per-agent results individually",
        "If your environment can submit results as each agent completes:",
        "1. Execute each agent independently",
        "2. For each completed agent, call `review_content_wizard_continue` with:",
        "   - The same sessionId, checkpoint, expectedRevision, continuationId",
        `   - \`agentId\`: the agent's ID (e.g., \`${(blueprint.agents[0] as any)?.id || "legal_compliance"}\`)`,
        "   - `result`: a JSON object with the agent's findings (agentId + status + output)",
        "3. Kevlar will auto-aggregate when all agents have reported",
        "",
      ].join("\n")
    : "";

  const agentListLines = blueprint.agents.map((a: any, i: number) =>
    `  ${i + 1}. \`${a.id}\` — **${a.role}**`,
  ).join("\n");
  const agentCount = blueprint.agents.length;

  return [
    "## Kevlar-4u Subagent Dispatch Request",
    "",
    // ── §1: Explicit mandatory requirement ──────────────────────────
    "### ⚠️ CRITICAL — You MUST create ALL subagents below",
    "",
    `This blueprint requires exactly **${agentCount} subagents**. You must create`,
    `every single one of them. **Skipping any agent will cause the receipt to be`,
    `REJECTED by Kevlar's validation gate.** The validation compares the receipt's`,
    `agent IDs against the blueprint and will fail if any are missing.`,
    "",
    "**The REQUIRED agents are:**",
    agentListLines,
    "",
    `**Total**: ${agentCount} subagents MUST be created and executed in parallel.`,
    "",
    "---",
    // ── §2: Phase 1 — Create all subagents ──────────────────────────
    "### Phase 1 — Create ALL subagents in parallel",
    "",
    "You MUST now create all subagents listed above. **Do not proceed to Phase 2",
    "until EVERY agent has returned its result.**",
    "",
    "**How to create subagents — pick YOUR platform:**",
    "",
    "**If you are WorkBuddy / QoderWork:**",
    "→ Use the `Agent` tool, set `subagent_type=\"general-purpose\"`, pass the agent's",
    "  `instructions` field as the prompt.",
    "",
    "**If you are OpenCode:**",
    "→ Use the `Task` tool, set `subagent_type=\"General\"`, pass the agent's",
    "  `instructions` field as the prompt.",
    "",
    "**If you are Claude Code / Cursor:**",
    "→ Use the `Task` tool, pass the agent's `instructions` as the task description.",
    "",
    "**If none of the above:**",
    "→ Use your platform's subagent/task creation tool with each agent's",
    "  `instructions` field as the task description.",
    "",
    "**Regardless of platform:**",
    "- Create exactly **one** subagent per agent ID listed above",
    "- Launch ALL subagents in **one message** (parallel dispatch)",
    "- Each subagent runs with isolated context — they do NOT share state",
    "- Wait for ALL results before proceeding to Phase 2",
    "",
    `**Expected in receipt**: exactly ${agentCount} agents with these IDs:`,
    `  ${blueprint.agents.map((a: any) => a.id).join(", ")}`,
    "",
    "**Reminder**: If you create fewer than all agents,",
    "the receipt will be REJECTED and you will waste a round-trip.",
    "",
    "---",
    // ── §3: Phase 2 — Aggregate and submit ──────────────────────────
    "### Phase 2 — Aggregate results and submit receipt",
    "",
    "**Only after ALL subagents have completed**, construct the ExecutionReceipt:",
    "",
    "1. Collect every agent's output (their `findings` array)",
    "2. Build the `agents` array with exactly one entry per agent — same ID and order",
    "3. Build the `aggregation` with one `dimensions` entry per agent (same IDs)",
    "4. Call `review_content_wizard_continue` with the complete receipt",
    "   (include sessionId, checkpoint, expectedRevision, and idempotencyKey as continuationId from the blueprint)",
    "",
    `The receipt MUST contain exactly ${agentCount} agent entries — no more, no less.`,
    "",
    "---",
    // ── §4: Anti-fabrication warning ──────────────────────────────
    "### ⛔ DO NOT FABRICATE OR INVENT AGENT OUTPUTS",
    "",
    "You MUST NOT fabricate, invent, or make up any agent's findings.",
    "Every finding in the receipt MUST come from the actual subagent's output.",
    "",
    "**If an agent failed to execute or did not return results:**",
    `- Set its \`status\` to \`"failed"\``,
    `- Set its \`output.findings\` to \`[]\` (empty array)`,
    `- In \`aggregation.dimensions\`, mark it as \`"⚠️ 未执行"\``,
    "",
    "**Falsifying agent results will corrupt the audit output** and may cause",
    "Kevlar to produce incorrect risk assessments. Always report truthfully.",
    "",
    "---",
    // ── §5: Receipt schema ──────────────────────────────────────────
    "### ExecutionReceipt Structure (kevlar.exec/v1)",
    "You MUST construct the receipt in EXACTLY this JSON shape:",
    "",
    "```",
    '{',
    '  "protocol": "kevlar.exec/v1",',
    '  "execution": {',
    '    "requestedMode": "ephemeral_agents",',
    '    "actualMode": "native_subagent",',
    `    "requestedConcurrency": ${agentCount},`,
    `    "actualConcurrency": ${agentCount},`,
    '    "contextIsolation": { "requested": true, "achieved": true },',
    '    "parallelism": "parallel",',
    '    "evidenceLevel": "host_attested"',
    '  },',
    '  "agents": [',
    '    {',
    '      "id": "<agent id from blueprint>",',
    '      "role": "<agent role from blueprint>",',
    '      "status": "completed",',
    '      "output": {',
    '        "findings": [',
    '          {',
    '            "keyword": "风险词汇",',
    '            "trigger": "触发原因",',
    '            "riskDescription": "风险说明",',
    '            "suggestedLevel": "🔴 或 🟡",',
    '            "propagationPath": "传播路径"',
    '          }',
    '        ]',
    '      }',
    '    }',
    '  ],',
    '  "aggregation": {',
    '    "dimensions": [',
    '      { "id": "<same agent id>", "level": "🟢/🟡/🔴", "findings": [] }',
    '    ],',
    '    "summary": "一句话总评"',
    '  }',
    '}',
    "```",
    "",
    "**Critical requirements:**",
    "- `agents[]` MUST contain exactly one entry per agent ID in the blueprint",
    "- `agents[].output` MUST be a JSON **object** (not a string) containing a `findings` array",
    "- `agents[].output.findings` MUST be an array (use `[]` if no findings)",
    "- `aggregation.dimensions` MUST be an array with one entry per agent (use same `id`)",
    "- `aggregation.summary` MUST be a string",
    "- Each agent's `output.findings` should contain the raw findings from that subagent's audit",
    "",
    perAgentGuidance,
    "### If you CANNOT execute subagent dispatch",
    "(e.g., your environment doesn't support parallel subagents)",
    "→ Call `review_content_wizard` again with the same sessionId:",
    `  \`sessionId\`: "${state.sessionId}"`,
    `  \`userMessage\`: "SEQUENTIAL_FALLBACK"`,
    "",
    "---",
    "### AgentBlueprint",
    "",
    "```json",
    JSON.stringify(blueprint, null, 2),
    "```",
  ].join("\n");
}

/**
 * Build a fully self-contained AgentBlueprint for parallel subagent dispatch.
 *
 * Each subagent receives its complete audit context (content, bare text,
 * local findings, core reasoning framework, execution protocol) directly
 * in its `instructions` field. No shared dispatch prompt is needed — the
 * Host AI maps each AgentDefinition to an independent subagent session.
 *
 * Phase 1 hardening:
 * - isolation.level changed from "best_effort" to "strict"
 * - PromptSegments (coreReasoningFramework, coreFrameworkSteps) inlined
 *   into each agent's instructions for true contextual isolation
 */
function buildAgentBlueprint(
  state: ReviewWizardState,
  systemAuditors: Persona[],
  prompts?: PromptSegments,
): AgentBlueprint {
  const content = state.content;
  const bareText = stripContext(content).bare;
  const localFindings = state.orchestrationPreAuditContext?.localFindings ?? [];
  const step0Result = state.orchestrationPreAuditContext?.step0Result;
  const webContextMap = state.orchestrationPreAuditContext?.webContextMap;
  const segs = prompts ?? loadPromptSegments("free");

  const agents: AgentDefinition[] = systemAuditors.map((auditor) => {
    let role = "safety_reviewer";
    if (auditor.meta.id === "legal_compliance") role = "policy_reviewer";
    else if (auditor.meta.id === "context_distortion") role = "context_reviewer";

    return {
      id: auditor.meta.id,
      role,
      instructions: buildIsolatedAgentInstructions(
        auditor, content, bareText, localFindings, segs,
        step0Result, webContextMap,
      ),
      input: {
        contentRef: "content",
      },
      outputSchema: "kevlar.reviewer/v1",
    };
  });

  // §2.1: agents length must equal 6 (6 defensive system auditors)
  if (agents.length !== 6) {
    logger.warn("AgentBlueprint agent count mismatch", {
      event: "agent_count_mismatch",
      expected: 6,
      actual: agents.length,
      agentIds: agents.map((a) => a.id),
    });
  }

  const activeCont = state.activeContinuation;

  return {
    protocol: "kevlar.exec/v1",
    execution: {
      mode: "ephemeral_agents",
      allowedModes: ["native_subagent", "simulated_agent"],
      concurrency: systemAuditors.length,
      isolation: {
        required: true,
        level: "strict",
      },
    },
    agents,
    aggregation: {
      strategy: "host_merge",
      rules: {
        requireAllAgents: true,
        conflictResolution: "risk_maximization",
        outputSchema: "kevlar.audit/v1",
      },
    },
    continuation: {
      tool: "review_content_wizard_continue",
      sessionId: state.sessionId,
      checkpoint: activeCont?.checkpoint || "preaudit_completed",
      expectedRevision: state.revision ?? 1,
      idempotencyKey: activeCont?.continuationId,
      // Pro: agent slot metadata for per-agent result submission
      ...(state.tier === "pro"
        ? {
            agentSlots: {
              total: agents.length,
              agentIds: agents.map((a) => a.id),
              allowPartialSubmit: true,
            } satisfies import("../execution/protocol.js").ContinuationSpec["agentSlots"],
          }
        : {}),
    },
  };
}

/**
 * Build a synthetic ExecutionReceipt from per-agent slot results for auto-aggregation.
 *
 * Maps each AgentSlotResult to a PreAuditDimensionResult using the
 * corresponding system auditor's identity. The output receipt conforms
 * to kevlar.exec/v1 and can be routed through handleSubagentAuditResult
 * which runs mergeLocalFindingsIntoAudits + calculateSynergy (Phase 1).
 */
export function buildSyntheticReceipt(
  agentSlots: Record<string, import("../execution/protocol.js").AgentSlotResult>,
  systemAuditors: Persona[],
): any {
  const slots = Object.values(agentSlots);
  const completedSlots = slots.filter((s) => s.status === "completed");
  const failedSlots = slots.filter((s) => s.status !== "completed");

  if (completedSlots.length === 0) {
    throw internalError("All agents failed — no completed results to aggregate");
  }

  const isPartial = failedSlots.length > 0;
  const agents = completedSlots.map((s) => ({
    id: s.agentId,
    status: s.status,
    output: s.output,
  }));

  const dimensions = completedSlots.map((s) => {
    const auditor = systemAuditors.find((a) => a.meta.id === s.agentId);
    const findings = (s.output?.findings ?? []).map((f: any) => ({
      ...f,
      _slotAgentId: s.agentId,
    }));
    const level = (s.output as any)?.overallLevel
      || guessLevelFromFindings(findings)
      || "🟢";
    return {
      id: s.agentId,
      name: auditor?.meta?.name || s.agentId,
      findings,
      level,
    };
  });

  const reportCount = dimensions.filter((d) => d.findings.length > 0).length;
  const totalSlots = slots.length;
  return {
    protocol: "kevlar.exec/v1",
    agents,
    ...(isPartial ? { _isPartial: true, _failedAgents: failedSlots.map((s) => s.agentId) } : {}),
    aggregation: {
      dimensions,
      summary: isPartial
        ? (reportCount > 0
          ? `${reportCount}/${dimensions.length} 个维度存在风险发现 (partial: ${failedSlots.length}/${totalSlots} agents unavailable)`
          : `全部维度通过 (partial: ${failedSlots.length}/${totalSlots} agents unavailable)`)
        : (reportCount > 0
          ? `${reportCount}/${dimensions.length} 个维度存在风险发现 (auto-aggregated)`
          : "全部维度通过 (auto-aggregated)"),
    },
  };
}

function guessLevelFromFindings(findings: any[]): string | undefined {
  if (!findings || findings.length === 0) return undefined;
  const levels = findings.map((f: any) => f.level || f.suggestedLevel || "🟢");
  if (levels.includes("🔴")) return "🔴";
  if (levels.includes("🟡")) return "🟡";
  return undefined;
}

/**
 * Build fully self-contained instructions for a single system auditor subagent.
 *
 * The instructions include everything the subagent needs to independently
 * audit the content: auditor identity, core reasoning framework, content
 * (original + decontextualized), local rule findings, and the full audit
 * execution protocol (Steps 1-3). No shared context required.
 */
function buildIsolatedAgentInstructions(
  auditor: Persona,
  content: string,
  bareText: string,
  localFindings: any[],
  segs: PromptSegments,
  step0Result?: Step0Result,
  webContextMap?: Record<string, string>,
): string {
  const parts: string[] = [];

  // ── 1. Auditor identity ─────────────────────────────────────────────
  parts.push(`你是 **${auditor.meta.name}**（${auditor.meta.id}）。`);
  parts.push(auditor.meta.description);
  parts.push("");

  // ── 2. Core reasoning framework (Pro-enhanced via PromptSegments) ──
  if (segs.coreReasoningFramework) {
    parts.push(segs.coreReasoningFramework);
    parts.push("");
  }

  // ── 3. Cold-read protocol steps ────────────────────────────────────
  if (segs.coreFrameworkSteps) {
    parts.push(segs.coreFrameworkSteps);
    parts.push("");
  }

  // ── 4. Auditor's system prompt (persona-specific rules) ────────────
  if (auditor.systemPrompt) {
    parts.push("## 【审查员角色规则】");
    parts.push(auditor.systemPrompt);
    parts.push("");
  }

  // ── 4.5. Step 0b global decoding results (when available) ──────────
  // Inject Step 0b output as fact anchors so subagents don't work
  // from pure reasoning alone. This includes: wild translations,
  // black atoms, attack candidates, and web search context from
  // the host AI's own web search tools.
  if (step0Result) {
    parts.push("## 【Step 0b 全局解码结果（职业黑粉逆向分析 + 联网搜索已完成）】");
    parts.push("以下结果是前置步骤中 Host AI 对本文案执行的全局逆向解码和联网验证。");
    parts.push("请将这些结果作为当前维度审计的**事实锚点**（而非凭空推理）：");
    parts.push("");

    if (step0Result.blackAtoms.length > 0) {
      parts.push("### 黑料原子（已提取的武器化片段）");
      parts.push("Host AI 从原文中提取的能被「恶意武器化」的片段：");
      parts.push(JSON.stringify(step0Result.blackAtoms, null, 2));
      parts.push("");
    }

    if (step0Result.attackCandidates.length > 0) {
      parts.push("### 攻击候选（可推演的完整攻击链）");
      parts.push("Host AI 对每个黑料原子推演的攻击传播路径：");
      parts.push(JSON.stringify(step0Result.attackCandidates, null, 2));
      parts.push("");
    }

    if (step0Result.wildTranslations.length > 0) {
      parts.push("### 野生翻译（外文词组的恶意谐音/歧义翻译）");
      parts.push(JSON.stringify(step0Result.wildTranslations, null, 2));
      parts.push("");
    }
  }

  if (webContextMap && Object.keys(webContextMap).length > 0) {
    parts.push("### 联网搜索验证结果");
    parts.push("Host AI 针对黑料原子关键词执行了联网搜索，以下为搜索结果参考：");
    parts.push("");
    for (const [keyword, context] of Object.entries(webContextMap)) {
      if (context.length > 3000) {
        parts.push(`🔍 搜索 "${keyword}" 结果摘要：${context.slice(0, 3000)}...（截断）`);
      } else {
        parts.push(`🔍 搜索 "${keyword}"：${context}`);
      }
      parts.push("");
    }
    parts.push("");
  }

  // ── 5. Content to audit ───────────────────────────────────────────
  parts.push("## 【待审核内容】");
  parts.push("");
  parts.push("### 原始文案");
  parts.push('"""');
  parts.push(content);
  parts.push('"""');
  parts.push("");
  parts.push("### 脱嵌文本（去除语境提示后的裸文，用于测试断章取义风险）");
  parts.push('"""');
  parts.push(bareText);
  parts.push('"""');
  parts.push("");

  // ── 6. Local rule engine findings ──────────────────────────────────
  if (localFindings.length > 0) {
    parts.push("## 【规则引擎预警（独立代码层检测结果，纳入审计参考）】");
    parts.push(JSON.stringify(localFindings, null, 2));
    parts.push("");
  }

  // ── 7. Audit execution protocol ────────────────────────────────────
  parts.push("## 【审计执行协议】");
  parts.push("");
  parts.push("### Step 1：当前维度沙盒推理");
  parts.push(`从 **${auditor.meta.name}** 的专业角度，对上述内容进行独立风险分析。`);
  parts.push("你必须假设这段内容遭遇了最恶劣的网络环境、最恶意的断章取义和带节奏。");
  parts.push("只要存在被恶意曲解的空间，即视为实质性风险。");
  parts.push("");
  parts.push("### Step 2：单沙盒仲裁与噪音过滤");
  parts.push("1. 逐一审查 Step 1 的发现，标记哪些属于过度联想（Noise）。");
  parts.push("   判断标准：能否推演出完整攻击链？不能则为 Noise。");
  parts.push("2. 确认最终发现列表中不含任何修改建议或文案优化意见。");
  parts.push("");
  parts.push("### Step 3：最终 JSON 输出");
  parts.push("请输出以下格式的纯 JSON，不包含 Markdown 标记或额外解释：");
  parts.push("");
  parts.push(JSON.stringify({
    findings: [{
      keyword: "风险词汇",
      trigger: "触发原因",
      riskDescription: "风险说明",
      propagationRisk: "传播风险",
      suggestedLevel: "🔴 或 🟡",
      propagationPath: "可选：原始表达 → 去语境化呈现 → 评论区反应 → 舆情走向",
    }],
  }, null, 2));
  parts.push("");
  parts.push("规则：");
  parts.push("- 无发现时 findings 必须为空数组");
  parts.push("- suggestedLevel 只能使用 🔴 或 🟡");
  parts.push("- 只要能推演出完整攻击链，必须进入 findings");

  return parts.join("\n");
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
  sendProgress?: (message: string) => void,
  strategyProvider?: StrategyProvider,
): Promise<ToolResult> {
  try {
    const parsed = resilientJsonParse(userMessage);

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
      throw validationError("Invalid Step 0 JSON: missing blackAtoms or attackCandidates");
    }
    if (Object.keys(webContextMap).length > 0 && precedents.length === 0) {
      throw validationError(
        "Invalid Step 0 JSON: webContextMap 非空（宿主 AI 已执行联网搜索）但 precedents 为空。" +
        "类似先例检索是 Step 0 的强制步骤（④），请在 JSON 中补充 precedents 字段后重新提交。"
      );
    }

    const localFindings = state.orchestrationPreAuditContext?.localFindings ?? [];
    const stripped = state.orchestrationPreAuditContext?.stripped ?? stripContext(state.content);

    state.orchestrationPreAuditContext = {
      localFindings,
      stripped,
      step0Result,
      webContextMap,
      precedents,
    };

    // ── Structured (mcp_subagent) path: Step 0b done, now dispatch subagents ──
    // The structured path entered waitingForOrchestrationStep0 first to let
    // the host AI complete web search. Now that we have step0Result +
    // webContextMap + precedents, we fork into the subagent dispatch phase.
    const plan = state.executionPlan;
    if (plan?.backend === "host_orchestration" && plan.strategy === "structured") {
      transitionState(state, "waitingForSubagentAudit", "structured_step0_completed");
      setContinuation(state, "waitingForSubagentAudit", "preaudit_completed");

      const prompts = await resolvePromptSegments();
      const blueprint = buildAgentBlueprint(state, systemAuditors, prompts);
      (state as any).blueprint = blueprint;

      await saveState(tmpDir, state);

      const blueprintText = renderBlueprintDispatchText(state, blueprint);
      return {
        content: [{ type: "text", text: blueprintText }],
      };
    }

    // Orchestration mode (Protocol v1): build context and emit Turn 2 audit prompt
    state.orchestrationPreAuditContext = buildOrchestrationPreAuditContext(
      state.content,
      localFindings,
      step0Result,
      webContextMap,
      precedents,
    );
    state.orchestrationPreAuditContext.stripped = stripped;
    transitionState(state, "waitingForOrchestrationAudit", "step0_result_parsed");
    setContinuation(state, "waitingForOrchestrationAudit", "preaudit_started");
    await saveState(tmpDir, state);

    return toolResponse(
      state,
      ORCHESTRATION_AUDIT_GUIDANCE +
        buildOrchestrationAuditPrompt(state.content, systemAuditors, state.orchestrationPreAuditContext),
    );
  } catch (err) {
    const info = getErrorInfo(err);
    await rollbackState(tmpDir, state.sessionId);
    const errMsg = formatErrorWithReportPrompt(
      [
        "❌ 无法解析宿主 AI 返回的 Turn 1 JSON。",
        `错误：${info.message}`,
        "请让宿主 AI 仅返回包含 blackAtoms、attackCandidates 和可选 webContextMap 的合法 JSON，然后再次提交。",
      ].join("\n"),
      "review_content_wizard",
    );
    return toolResponse(state, errMsg);
  }
}

// resolveSystemAuditCaller removed — Protocol v1 delegates all LLM calls to Host.

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
  strategyProvider?: StrategyProvider,
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
    strategyProvider?.getSynergyRules?.(),
  );
}

async function handleOrchestrationAuditResult(
  tmpDir: string,
  state: ReviewWizardState,
  userPersonas: Persona[],
  systemAuditors: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
  strategyProvider?: StrategyProvider,
): Promise<ToolResult> {
  try {
    const parsed = resilientJsonParse(userMessage);
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
    const synergyResult = calculateSynergy(dimensionLevels, timingFlag, strategyProvider?.getSynergyRules?.());

    // Extract deltaRisks from Turn 2 (with fallback)
    const deltaRisks = parsed.deltaRisks ?? buildEmptyDeltaRisks();

    // Store Turn 2 results for Turn 3
    state.orchestrationTurn2Results = {
      mergedDimensions,
      synergyResult,
      deltaRisks,
    };
    transitionState(state, "waitingForOrchestrationFinal", "turn2_audit_processed");
    setContinuation(state, "waitingForOrchestrationFinal", "preaudit_completed");
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
    const errMsg = formatErrorWithReportPrompt(
      [
        "❌ 无法解析宿主 AI 返回的 Turn 2 审计 JSON。",
        `错误：${info.message}`,
        "请让宿主 AI 仅返回包含 dimensions 和 deltaRisks 的合法 JSON，不要包含 Markdown 或解释文字，然后再次提交。",
      ].join("\n"),
      "review_content_wizard",
    );
    return toolResponse(state, errMsg);
  }
}

/**
 * Handle subagent audit result: parse the aggregated result from host AI
 * after it has executed the subagent dispatch prompt.
 *
 * This is similar to handleOrchestrationAuditResult, but instead of
 * advancing to Turn 3 (waitingForOrchestrationFinal), it advances directly
 * to rstConfirmation or checkPersonaInventory because the subagent dispatch
 * prompt already asks the host AI to do the cross-validation and final arbitration.
 */
async function handleSubagentAuditResult(
  tmpDir: string,
  state: ReviewWizardState,
  userPersonas: Persona[],
  systemAuditors: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
  strategyProvider?: StrategyProvider,
): Promise<ToolResult> {
  // ── SEQUENTIAL_FALLBACK → drop to standard orchestration ───────────────
  if (userMessage.trim().includes("SEQUENTIAL_FALLBACK")) {
    fallbackToStandardOrchestration(state, "subagent_fallback");
    const localFindings = state.orchestrationPreAuditContext?.localFindings ?? [];
    const stripped = state.orchestrationPreAuditContext?.stripped ?? stripContext(state.content);
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      ORCHESTRATION_STEP0_GUIDANCE + buildOrchestrationStep0Prompt(state.content, localFindings, stripped),
    );
  }

  // ── Early schema validation ─────────────────────────────────────────────
  let parsed: any;
  try {
    parsed = resilientJsonParse(userMessage);
  } catch (jsonErr: any) {
    await rollbackState(tmpDir, state.sessionId);
    const errMsg = formatErrorWithReportPrompt(
      [
        "❌ **无法解析 Host AI 返回的 Subagent ExecutionReceipt**",
        "",
        `解析错误：${jsonErr?.message || "未知错误"}`,
        "请确保 receipt 符合 `kevlar.exec/v1` 协议格式。",
        `当前重试次数：${(state.activeContinuation?.retryCount ?? 0) + 1}`,
      ].join("\n"),
      "review_content_wizard",
    );
    return toolResponse(state, errMsg);
  }

  const validation = validateReceipt(parsed);
  if (!validation.valid) {
    await rollbackState(tmpDir, state.sessionId);
    return toolResponse(
      state,
      [
        "❌ **Subagent ExecutionReceipt 格式错误**",
        "",
        ...validation.errors.map((e: string) => `- ${e}`),
        ...(validation.warnings.length > 0 ? ["", "⚠️ 警告:"] : []),
        ...validation.warnings.map((w: string) => `- ${w}`),
        `当前重试次数：${(state.activeContinuation?.retryCount ?? 0) + 1}`,
      ].join("\n"),
    );
  }

  try {
    // Record positive observation: Host successfully returned structured JSON
    recordCapabilityObservation(
      getClientFingerprint(),
      inferTaskClass(state.content),
      "format_verified",
      "kevlar_result_schema_matched",
    );

    const localFindings = state.orchestrationPreAuditContext?.localFindings ?? [];
    const content = state.content;
    const precedents = state.orchestrationPreAuditContext?.precedents ?? [];

    const aggregation = parsed.aggregation || parsed.output || (parsed.dimensions ? parsed : null);
    if (!aggregation) {
      throw internalError("Missing aggregation report in ExecutionReceipt");
    }

    const crossValidatedDimensions = aggregation.dimensions || [];
    const worstCaseNarrative = aggregation.worstCaseNarrative || "";
    const attackChainAnalysis = aggregation.attackChainAnalysis || "";
    const riskProfile = aggregation.riskProfile || {};
    const deltaRisks = aggregation.deltaRisks || buildEmptyDeltaRisks();

    // ── Step 5: Merge local findings into audit results (code step)
    const mergedDimensions = normalizePreAuditDimensions(
      mergeLocalFindingsIntoAudits(
        normalizePreAuditDimensions(crossValidatedDimensions, systemAuditors),
        localFindings,
      ),
      systemAuditors,
    );

    // ── Phase 2: LLM cross-validation (Step 6) for auto-aggregated slot results ──
    let dimensionsForSynergy = mergedDimensions;
    const isAutoAggregated = state.agentSlots
      && Object.keys(state.agentSlots.received).length > 0;
    if (isAutoAggregated && samplingFn) {
      try {
        dimensionsForSynergy = await crossValidateRiskyDimensions(
          content,
          mergedDimensions,
          systemAuditors,
          samplingFn,
        );
      } catch (err) {
        logger.warn("Auto-aggregation cross-validation failed, using merged dimensions", {
          event: "slot_cross_validation_failed",
          error: getErrorInfo(err).message,
        });
      }
    }

    // ── Step 7: Synergy calculation (code step)
    const dimensionLevels: Record<string, string> = {};
    for (const dim of dimensionsForSynergy) {
      dimensionLevels[dim.id] = dim.level ?? "🟢";
    }
    const timingFlag = localFindings.some((f: any) => f.timingWindowId) ? ["timing_risk"] : [];
    const synergyResult = calculateSynergy(dimensionLevels, timingFlag, strategyProvider?.getSynergyRules?.());

    // Apply synergy level upgrades
    if (synergyResult.levelUpgrades.length > 0) {
      for (const upgrade of synergyResult.levelUpgrades) {
        const dim = dimensionsForSynergy.find((d: any) => d.id === upgrade.dimension);
        if (dim && dim.level === upgrade.from) {
          dim.level = upgrade.to;
        }
      }
    }

    // ── Phase 5: Step 8 — LLM final arbitration for auto-aggregated slot results ──
    let finalReport: PreAuditReport | null = null;
    if (isAutoAggregated && samplingFn) {
      try {
        const step8Prompts = await resolvePromptSegments();
        finalReport = await finalizePreAuditReport(
          content,
          localFindings,
          mergedDimensions,
          dimensionsForSynergy,
          systemAuditors,
          samplingFn,
          synergyResult,
          deltaRisks,
          precedents,
          step8Prompts,
        );
      } catch (err) {
        logger.warn("Auto-aggregation final arbitration failed, using synergy result", {
          event: "slot_final_arbitration_failed",
          error: getErrorInfo(err).message,
        });
      }
    }

    // Construct final preAuditReport conforming to kevlar.audit/v1
    const preAuditReport: PreAuditReport = finalReport ?? {
      dimensions: dimensionsForSynergy,
      summary: aggregation.summary || (dimensionsForSynergy.some((d) => d.findings.length > 0)
        ? `${dimensionsForSynergy.filter((d) => d.findings.length > 0).length}/${dimensionsForSynergy.length} 个维度存在风险发现`
        : "全部维度通过"),
      attackChainAnalysis: attackChainAnalysis || aggregation.attackChainAnalysis || "",
      worstCaseNarrative: worstCaseNarrative || aggregation.worstCaseNarrative || "",
      riskProfile: riskProfile || aggregation.riskProfile || {},
      synergyFlags: synergyResult,
      deltaRisks,
      precedents,
    };

    state.preAuditReport = preAuditReport;
    state.systemAuditorIds = systemAuditors.map((a) => a.meta.id);
    state.step = (state.tier === "pro" || process.env.KEVLAR_TIER === "pro") ? "rstConfirmation" : "checkPersonaInventory";
    await saveState(tmpDir, state);

    logger.info("Subagent audit receipt processed", {
      event: "subagent_audit_processed",
      dimensionCount: preAuditReport.dimensions.length,
      synergyTriggered: synergyResult.triggered.length > 0,
    });

    if (state.step === "rstConfirmation") {
      const prompts = await resolvePromptSegments();
      return toolResponse(
        state,
        [
          buildPreAuditSummaryBlock(state, prompts),
          "",
          "六维风险检测已完成（Subagent 并行模式）。是否继续进行舆论仿真推演？",
          "",
          "回复「继续」或「是」进入评审，回复「否」结束。",
        ].join("\n"),
      );
    }
    return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
  } catch (err) {
    const info = getErrorInfo(err);
    await rollbackState(tmpDir, state.sessionId);
    const errMsg = formatErrorWithReportPrompt(
      [
        "❌ 无法解析宿主 AI 返回的 ExecutionReceipt。",
        `错误：${info.message}`,
        "请确保返回符合 protocol.ts 中 ExecutionReceipt 规格的 JSON 对象。",
      ].join("\n"),
      "review_content_wizard",
    );
    return toolResponse(state, errMsg);
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
    const parsed = resilientJsonParse(userMessage);
    const turn2 = state.orchestrationTurn2Results;

    if (!turn2) {
      throw internalError("Missing Turn 2 intermediate results (orchestrationTurn2Results)");
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
          "六维风险检测已完成。是否继续进行舆论仿真推演？",
          "",
          "回复「继续」或「是」进入评审，回复「否」结束。",
        ].join("\n"),
      );
    }
    return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
  } catch (err) {
    const info = getErrorInfo(err);
    await rollbackState(tmpDir, state.sessionId);
    const errMsg = formatErrorWithReportPrompt(
      [
        "❌ 无法解析宿主 AI 返回的 Turn 3 最终仲裁 JSON。",
        `错误：${info.message}`,
        "请让宿主 AI 仅返回包含 dimensions、summary、worstCaseNarrative 的合法 JSON，然后再次提交。",
      ].join("\n"),
      "review_content_wizard",
    );
    return toolResponse(state, errMsg);
  }
}

async function buildRuleFindings(skillsDir: string, content: string, targetRegions?: string[]): Promise<any[]> {
  const repo = new RuleRepository(skillsDir);
  const loaded = await repo.loadRules(undefined, targetRegions);
  if (!loaded) return [];

  const findings: any[] = [];

  // ── 0.1 时机节点检测 ───────────────────────────────────────────────────
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
        trigger: `规则命中：${candidate} -> ${match.rule.root}`,
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
  const detail = parts.length > 0 ? parts.join("；") : "存在潜在语义或传播风险，建议通过舆论仿真推演确认。";
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
  if (results.length === 0) return "规则与系统审查员均未命中风险点";

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

// ── 辅助：构建六维风险检测结果展示块 ─────────────────────────────────────────

function buildPreAuditSummaryBlock(state: ReviewWizardState, prompts?: PromptSegments): string {
  const segs = prompts ?? loadPromptSegments("free");
  const lines: string[] = ["<!-- kevlar:verbatim-pre-audit:start -->", "六维风险检测结果"];
  if (state.preAuditReport?.summary) {
    lines.push(state.preAuditReport.summary);
  } else {
    lines.push("", "未找到系统审查员，跳过六维风险检测");
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


// ── 检测完成：展示结果并询问下一步 ────────────────────────────────────────────
//
// Free 版：直接显示 3 个选项（无预检测结果块）
// Pro 版：显示六维风险检测结果 + 2 个选项

async function handleInventoryCheck(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  const prompts = await resolvePromptSegments();
  const isFree = state.tier === "free";

  const proOptions = [
    "<!-- kevlar:verbatim-options:start -->",
    "六维风险检测已完成。请选择：",
    "1. 舆论仿真推演 — 由评审员角色模拟真实用户的评论区反应",
    "2. 目标平台风控模拟（暂未开放，敬请期待）",
    "<!-- kevlar:verbatim-options:end -->",
  ].join("\n");

  // 无评审员：提示创建，流程暂停
  if (personas.length === 0) {
    transitionState(state, "waitingForPersonaCreation", "no_personas_available");
    state.selectedPersonaIds = [];
    state.remainingPersonaIds = [];
    await saveState(tmpDir, state);
    const summaryBlock = isFree ? "" : buildPreAuditSummaryBlock(state, prompts) + "\n\n";
    return toolResponse(
      state,
      [
        summaryBlock,
        "当前还没有可用评审员。请先创建至少一个角色，再继续这次内容评测。",
        "",
        "我已经暂存了本次待评测内容；创建角色后，带上这个 sessionId 再次调用 review_content_wizard 即可继续。",
      ].filter(Boolean).join("\n"),
    );
  }

  if (isFree) {
    // Free 版：AI 推荐 + 用户选择
    const usedIds = new Set(state.usedPersonaIds || []);
    const availablePersonas = personas.filter(p => !usedIds.has(p.meta.id));
    const targetPersonas = availablePersonas.length > 0 ? availablePersonas : personas;

    const recommendation = await recommendPersonas(state, targetPersonas, samplingFn);
    const recommendedSet = new Set(recommendation.personaIds);
    const recommendedPersonas = targetPersonas.filter(p => recommendedSet.has(p.meta.id));
    const displayPersonas = recommendedPersonas.length > 0 ? recommendedPersonas : targetPersonas.slice(0, 3);

    state.pendingPersonaIds = displayPersonas.map(p => p.meta.id);
    transitionState(state, "waitingForReviewDecision", "inventory_check_completed");
    await saveState(tmpDir, state);

    const displayText = [
      "<!-- kevlar:verbatim-options:start -->",
      "接下来进行舆论仿真推演。根据内容特色，推荐了以下评审员：",
      "",
      ...displayPersonas.map((p, i) =>
        `${i + 1}. ${p.meta.name} · ${p.meta.tags.join("、") || "通用"}`,
      ),
      "",
      "输入编号选择评审员（例如「1,2」），或回复：",
      "- 「查看全部」浏览所有评审员",
      "- 「创建」新建评审员",
      "<!-- kevlar:verbatim-options:end -->",
    ].join("\n");

    return toolResponse(state, displayText);
  }

  // Pro 版：显示六维风险检测结果 + 选项
  transitionState(state, "waitingForReviewDecision", "inventory_check_completed");
  await saveState(tmpDir, state);

  const summaryBlock = buildPreAuditSummaryBlock(state, prompts) + "\n\n";
  return toolResponse(state, summaryBlock + proOptions);
}

// ── 用户选择下一步 ────────────────────────────────────────────────────────────

async function handleReviewDecision(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  const normalized = userMessage.trim();
  const isFree = state.tier === "free";

  // ═══ Free 版：编号选择 / 查看全部 / 创建 ═══
  if (isFree) {
    if (/^(创建|新建|新增|new|create)$/i.test(normalized)) {
      transitionState(state, "waitingForPersonaCreation", "user_wants_new_persona");
      await saveState(tmpDir, state);
      return toolResponse(state, "好的，开始创建新评审员。创建完成后将回到内容评测流程。");
    }

    if (/^(查看全部|全部|所有|完整列表|show all|all)$/i.test(normalized)) {
      state.pendingPersonaIds = personas.map(p => p.meta.id);
      await saveState(tmpDir, state);
      const personaLines = personas.map((p, i) =>
        `${i + 1}. ${p.meta.name} · ${p.meta.tags.join("、") || "通用"}`,
      );
      return toolResponse(state,
        "<!-- kevlar:verbatim-options:start -->\n" +
        "所有评审员（共 " + personas.length + " 位）：\n\n" +
        personaLines.join("\n") +
        "\n\n输入编号选择（例如「1,3,5」），或回复「创建」新建评审员。\n" +
        "<!-- kevlar:verbatim-options:end -->",
      );
    }

    const numbers = normalized.split(/[,，、\s]+/)
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n) && n > 0);

    if (numbers.length > 0) {
      if (numbers.length > 5) {
        return toolResponse(state, "❌ 一次最多选择 5 位评审员。请重新选择。");
      }

      const pendingIds = state.pendingPersonaIds || personas.map(p => p.meta.id);
      const maxIndex = Math.max(...numbers);

      if (maxIndex > pendingIds.length) {
        return toolResponse(state,
          "❌ 编号 " + maxIndex + " 超出范围（共 " + pendingIds.length + " 位评审员）。请重新输入。",
        );
      }

      const selectedIds = [...new Set(numbers.map(n => pendingIds[n - 1]).filter(Boolean))];

      state.selectedPersonaIds = selectedIds;
      state.remainingPersonaIds = personas
        .filter(p => !selectedIds.includes(p.meta.id))
        .map(p => p.meta.id);

      // Directly execute: user explicitly chose by number, no need for extra confirmation
      await saveState(tmpDir, state);
      return executeReview(skillsDir, tmpDir, state, samplingFn);
    }

    return toolResponse(state,
      "<!-- kevlar:verbatim-options:start -->\n请输入编号选择评审员（例如「1,2」），或回复「查看全部」「创建」。\n<!-- kevlar:verbatim-options:end -->",
    );
  }

  // ═══ Pro 版：保留原有选项 ═══
  if (/^(2|目标平台风控模拟|平台风控|风控模拟|平台检查|平台违禁限流排查|违禁限流排查)$/i.test(normalized)) {
    return toolResponse(
      state,
      [
        "<!-- kevlar:verbatim-options:start -->",
        "目标平台风控模拟暂未开放，敬请期待。",
        "",
        "请选择：",
        "1. 舆论仿真推演 — 由评审员角色模拟真实用户的评论区反应",
        "2. 目标平台风控模拟（暂未开放，敬请期待）",
        "<!-- kevlar:verbatim-options:end -->",
      ].join("\n"),
    );
  }

  const wantsReview = /^(1|需要|开始|开始舆论仿真推演|确认|执行|继续|好的|好|ok|yes|舆论仿真推演|舆论仿真|仿真推演)$/i.test(normalized);

  if (!wantsReview) {
    return toolResponse(
      state,
      [
        "<!-- kevlar:verbatim-options:start -->",
        "请选择：",
        "1. 舆论仿真推演 — 由评审员角色模拟真实用户的评论区反应",
        "2. 目标平台风控模拟（暂未开放，敬请期待）",
        "<!-- kevlar:verbatim-options:end -->",
      ].join("\n"),
    );
  }

  // 用户确认：执行评审员推荐
  if (personas.length <= 2) {
    transitionState(state, "waitingForReviewerConfirmation", "personas_auto_selected_all");
    state.selectedPersonaIds = [...personas.map((p) => p.meta.id)];
    state.remainingPersonaIds = [];
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        "<!-- kevlar:verbatim-options:start -->",
        `当前共有 ${personas.length} 位评审员，已全部选中：`,
        "",
        ...personas.map(
          (p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.tags.join("、") || "通用"} · ${p.meta.description}`,
        ),
        "",
        "请回复「开始舆论仿真推演」确认执行，或回复「X 换一位」替换指定评审员（例如：2 换一位）。",
        "<!-- kevlar:verbatim-options:end -->",
      ].join("\n"),
    );
  }

  const recommendation = await recommendPersonas(state, personas, samplingFn);
  const recommendedIds = new Set(recommendation.personaIds);

  state.selectedPersonaIds = [...recommendation.personaIds];
  state.remainingPersonaIds = personas.filter((p) => !recommendedIds.has(p.meta.id)).map((p) => p.meta.id);
  transitionState(state, "waitingForReviewerConfirmation", "recommendation_completed");
  await saveState(tmpDir, state);

  const remainingPersonas = personas.filter((p) => !recommendedIds.has(p.meta.id));
  return toolResponse(
    state,
    [
      "<!-- kevlar:verbatim-options:start -->",
      recommendation.assistantMessage,
      "",
      ...(remainingPersonas.length > 0
        ? [
            "**备选评审员**（暂未选入）：",
            ...remainingPersonas.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
          ]
        : []),
      "",
      "请回复「开始舆论仿真推演」确认执行，或回复「X 换一位」替换指定评审员（例如：2 换一位）。",
      "<!-- kevlar:verbatim-options:end -->",
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

  // "开始舆论仿真推演" → 直接执行
  if (/^(开始舆论仿真推演|开始仿真推演|确认|执行)$/.test(normalized)) {
    if (state.selectedPersonaIds.length === 0) {
      return toolResponse(state, "❌ 当前没有已选择的评审员。请先通过「X 换一位」选择评审员后再试。");
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
      "<!-- kevlar:verbatim-options:start -->",
      "当前已选评审员：",
      ...selectedUserPersonas.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
      "",
      ...(remaining.length > 0
        ? [`备选评审员（共 ${remaining.length} 位）`, "请回复「X 换一位」替换指定评审员（例如：2 换一位）。"]
        : []),
      "",
      "请回复「开始舆论仿真推演」确认执行，或回复「X 换一位」替换指定评审员。",
      "<!-- kevlar:verbatim-options:end -->",
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
        `❌ 编号 ${position} 超出范围。当前已选评审员：`,
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
        "当前已选评审员：",
        ...selected.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
        "",
        "请回复「开始舆论仿真推演」确认执行。",
      ].join("\n"),
    );
  }

  const removedId = state.selectedPersonaIds[position - 1];
  const removedPersona = personas.find((p) => p.meta.id === removedId);

  const addedId = state.remainingPersonaIds.shift()!;
  state.selectedPersonaIds = state.selectedPersonaIds.filter((id) => id !== removedId);
  state.selectedPersonaIds.push(addedId);
  state.remainingPersonaIds.push(removedId);

  transitionState(state, "waitingForReviewerConfirmation", "reviewer_swapped");
  await saveState(tmpDir, state);

  const updatedSelected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
  const remaining = personas.filter((p) => state.remainingPersonaIds.includes(p.meta.id));
  const addedPersona = personas.find((p) => p.meta.id === addedId);

  return toolResponse(
    state,
    [
      `✅ 已替换：${removedPersona?.meta.name || "未知"} → ${addedPersona?.meta.name || "未知"}`,
      "",
      "当前已选评审员：",
      ...updatedSelected.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
      "",
      ...(remaining.length > 0 ? [`备选评审员（共 ${remaining.length} 位）`] : []),
      "请回复「开始舆论仿真推演」确认执行，或回复「X 换一位」继续替换。",
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
          '你是评审员推荐助手。根据待评测内容推荐 1-3 个最匹配的评审员，输出 JSON：{"personaIds":["id"],"assistantMessage":"推荐理由"}。assistantMessage 应包含「根据内容特色，为您推荐了 X 位合适的评审员」及每位推荐评审员的简要理由。不要输出 markdown。',
        messages: [
          {
            role: "user",
            content: JSON.stringify(include),
          },
        ],
        maxTokens: 3072,
      });
      const parsed = resilientJsonParse(response.content.trim()) as Record<string, unknown>;
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

// ── 评审完成：下一轮选择 ────────────────────────────────────────────────────────

async function handleNextRound(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  const normalized = userMessage.trim().toLowerCase();

  // 换一批评审员
  if (/^(换一批|换|继续|继续评测|再来一轮|next|continue|1)$/i.test(normalized)) {
    await saveState(tmpDir, state);
    return handleInventoryCheck(tmpDir, state, personas, samplingFn);
  }

  const proActive = isPro();

  // 解锁 Pro / 继续多维评审
  if (/^(解锁|升级|pro|专业版|六维|六维风险检测|解锁pro|继续多维|多维评审|3)$/i.test(normalized)) {
    if (proActive) {
      // Pro 用户：重定向到六维检测复用 → 评审员推演
      transitionState(state, "checkPersonaInventory", "pro_multi_dim_continue");
      await saveState(tmpDir, state);
      return handleInventoryCheck(tmpDir, state, personas, samplingFn);
    }
    return toolResponse(
      state,
      [
        "<!-- kevlar:verbatim-options:start -->",
        "六维风险检测是 Pro 版专属功能，可对内容进行合规、语境、网络文化、事实与跨语言全维度深度分析。",
        "",
        "升级方式：",
        "1. 运行 `npx kevlar-4u --activate --code <激活码>`",
        "2. 或访问 https://kevlar4u.xyz 获取激活码",
        "",
        "升级后请重新调用 review_content_wizard 继续评测。",
        "<!-- kevlar:verbatim-options:end -->",
      ].join("\n"),
    );
  }

  // 结束评测
  if (/^(结束|停止|退出|完成|不|不了|算了|结束评测|exit|quit|no|2)$/i.test(normalized)) {
    transitionState(state, "completed", "user_ended");
    await cleanupState(tmpDir, state.sessionId);
    return toolResponse(state, "评测已结束。需要评测新内容时，请重新开始。");
  }

  const usedIds = new Set(state.usedPersonaIds || []);
  const remainingCount = personas.filter(p => !usedIds.has(p.meta.id)).length;
  const proOption = proActive
    ? "- 继续多维评审（Pro）🔓"
    : "- 解锁六维风险检测 🔓（专业版）";
  const swapOption = remainingCount > 0
    ? `- 换一批评审员 — 从未参与本轮的角色中重新筛选（剩余 ${remainingCount} 位）`
    : "- 换一批评审员 — 所有评审员均已参与";

  return toolResponse(
    state,
    [
      "<!-- kevlar:verbatim-options:start -->",
      "评测完成。是否继续？",
      swapOption,
      proOption,
      "- 结束评测",
      "<!-- kevlar:verbatim-options:end -->",
    ].join("\n"),
  );
}

async function handleRstConfirmation(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  const normalized = userMessage.trim().toLowerCase();
  const wantsRst = /^(是|继续|确认|好的|好|yes|y|1|开始|舆论仿真推演|仿真推演|开始仿真推演|开始舆论仿真推演)$/i.test(normalized);

  if (wantsRst) {
    transitionState(state, "checkPersonaInventory", "rst_confirmed");
    await saveState(tmpDir, state);
    // Pre-audit results are in state.preAuditReport; they flow into
    // Focus Topics when RST runs via handleInventoryCheck → executeReview.
    return handleInventoryCheck(tmpDir, state, personas, samplingFn);
  }

  const wantsSkip = /^(否|不|取消|跳过|不用|不需要|结束|退出|skip|no|n|2)$/i.test(normalized);
  if (wantsSkip) {
    transitionState(state, "completed", "rst_skipped");
    await saveState(tmpDir, state);
    return toolResponse(state, "六维风险检测已完成，未进入舆论仿真推演。需要评测新内容时，请重新开始。");
  }

  return toolResponse(
    state,
    [
      "六维风险检测已完成。是否继续进行舆论仿真推演？",
      "",
      "回复「继续」或「是」进入评审，回复「否」结束。",
    ].join("\n"),
  );
}

// ── Persona Agent Blueprint (Stage 2 Subagent Dispatch) ──────────────────────

/**
 * Build fully isolated prompt instructions for a single persona agent.
 *
 * Each persona agent receives its complete review context inline,
 * so it can run in a truly isolated subagent without external references.
 */
function buildIsolatedPersonaPrompt(
  persona: Persona,
  content: string,
  contextNote: string | undefined,
  dimensions: DimensionsConfig,
  preAuditReport: any,
): string {
  const meta = persona.meta;

  const parts: string[] = [];

  // 1. Persona system prompt (user-defined)
  if (persona.systemPrompt) {
    parts.push(persona.systemPrompt);
    parts.push("");
  }

  // 2. Persona context: identity, background, blind spots
  parts.push(buildPersonaContextDirective(meta));

  // 3. Tone constraints
  if (meta.tone) {
    parts.push(buildToneDirective(meta.tone));
  }

  // 4. Defensive system directive (mandatory for all reviewers)
  parts.push(buildDefensiveSystemDirective());

  // 5. Offensive system directive (based on config)
  const offensive = buildOffensiveSystemDirective(dimensions);
  if (offensive) {
    parts.push(offensive);
  }

  // 6. Review task with content + pre-audit context
  parts.push(buildReviewUserMessage(content, contextNote, dimensions, preAuditReport));

  // 7. Structured JSON output requirement
  parts.push([
    "## 📤 输出格式（严格 JSON）",
    "",
    "请以以下 JSON 格式输出你的评审结果（不要包含 markdown 代码块标记）：",
    "",
    "```json",
    "{",
    '  "personaId": "' + meta.id + '",',
    '  "personaName": "' + meta.name + '",',
    '  "findings": [',
    '    {',
    '      "keyword": "风险词汇或争议点",',
    '      "trigger": "触发原因",',
    '      "riskDescription": "风险说明",',
    '      "suggestedLevel": "🔴 或 🟡",',
    '      "propagationPath": "传播路径",',
    '      "personaReaction": "该评审员的真实反应"',
    '    }',
    '  ],',
    '  "offensiveDimensions": [',
    '    { "dimension": "维度名", "level": "🟢/🟡/🔴", "reasoning": "判定依据" }',
    "  ],",
    '  "defensiveDimensions": [',
    '    { "dimension": "维度名", "level": "🟢/🟡/🔴", "reasoning": "判定依据" }',
    "  ],",
    '  "overallConclusion": "一句话总评",',
    '  "mostDestructiveRisk": "最具破坏性的风险点",',
    '  "coreControversy": "核心争议焦点",',
    '  "simulatedReaction": "模拟该角色在评论区可能发表的真实反应（口语化、短句、带语气词/吐槽/个人情绪，可以有不完美表达，不要长篇大论，不要总结性语言，根据该评审员的性格特点进行评论）"',
    "}",
    "```",
    "",
    "⚠️ 输出必须是纯 JSON，不要加 ```json 标记或任何解释文字。",
    "",
    "**重要**：`findings` 字段是必须的——将你在 offensiveDimensions 中标记为 🟡 或 🔴 的每个维度，",
    "转化为一个 finding 对象放入 `findings` 数组。无风险时 findings 必须为空数组 `[]`。",
    "宿主AI 会将你的 `findings` 数组直接放入 ExecutionReceipt 的 `agents[].output.findings` 中。",
  ].join("\n"));

  return parts.join("\n\n");
}

/**
 * Build the Persona AgentBlueprint for Stage 2: parallel isolated persona reviews.
 */
function buildPersonaAgentBlueprint(
  state: ReviewWizardState,
  personas: Persona[],
): AgentBlueprint {
  const dimensions = state.dimensions ?? DEFAULT_DIMENSIONS_CONFIG;
  const contextNote = state.context;
  const content = state.content;
  const preAuditReport = state.preAuditReport;

  const agents: AgentDefinition[] = personas.map((p) => {
    const instructions = buildIsolatedPersonaPrompt(
      p,
      content,
      contextNote,
      dimensions,
      preAuditReport,
    );

    return {
      id: p.meta.id,
      role: "persona_reviewer",
      instructions,
      input: {
        contentRef: "_inline_",
      },
      outputSchema: "kevlar.reviewer/v1",
    };
  });

  return {
    protocol: "kevlar.exec/v1",
    execution: {
      mode: "ephemeral_agents",
      allowedModes: ["native_subagent", "simulated_agent"],
      concurrency: personas.length,
      isolation: {
        required: true,
        level: "strict",
      },
    },
    agents,
    aggregation: {
      strategy: "host_merge",
      rules: {
        requireAllAgents: true,
        conflictResolution: "host_decide",
        outputSchema: "kevlar.audit/v1",
      },
    },
    continuation: {
      tool: "review_content_wizard_continue",
      sessionId: state.sessionId,
      checkpoint: "persona_audit_started",
      expectedRevision: state.revision ?? 1,
      idempotencyKey: state.activeContinuation?.continuationId,
      // Pro: agent slot metadata for per-agent result submission
      ...(state.tier === "pro"
        ? {
            agentSlots: {
              total: agents.length,
              agentIds: agents.map((a) => a.id),
              allowPartialSubmit: true,
            } satisfies import("../execution/protocol.js").ContinuationSpec["agentSlots"],
          }
        : {}),
    },
  };
}

/**
 * Handle the Host AI's ExecutionReceipt from parallel persona review dispatch.
 *
 * Parses each persona agent's structured output, aggregates into a final
 * combined report, and marks the wizard as completed.
 */
async function handlePersonaAuditResult(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  // ── SEQUENTIAL_FALLBACK → return to review decision ────────────────────
  if (userMessage.trim().includes("SEQUENTIAL_FALLBACK")) {
    transitionState(state, "waitingForReviewDecision", "subagent_fallback");
    const allPersonas = personas.length > 0 ? personas : await loadAllPersonas(tmpDir.replace("/tmp/", ""));
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        "⚠️ **宿主 AI 不支持并行 Subagent 调度**",
        "",
        "当前客户端环境无法为每位评审员创建独立的并行子代理。",
        "请切换至支持 Task/Subagent 工具的 MCP 客户端（如 Claude Code、opencode），",
        "或使用 standard 编排模式重新开始评测。",
        "",
        "你仍然可以在此会话中重新选择评审员：",
        ...personas.map((p, i) => `  ${i + 1}. ${p.meta.name}`),
        "",
        "输入编号重新选择，或回复「结束」退出评测。",
      ].join("\n"),
    );
  }

  // ── Early schema validation ─────────────────────────────────────────────
  let parsed: any;
  try {
    parsed = resilientJsonParse(userMessage);
  } catch (jsonErr: any) {
    await rollbackState(tmpDir, state.sessionId);
    const errMsg = formatErrorWithReportPrompt(
      [
        "❌ **无法解析宿主 AI 返回的 Persona ExecutionReceipt**",
        "",
        `解析错误：${jsonErr?.message || "未知错误"}`,
        "请确保 receipt 符合 `kevlar.exec/v1` 协议格式。",
        `当前重试次数：${(state.activeContinuation?.retryCount ?? 0) + 1}`,
        "",
        '如果你的环境不支持并行 Subagent，请发送：`SEQUENTIAL_FALLBACK`',
      ].join("\n"),
      "review_content_wizard",
    );
    return toolResponse(state, errMsg);
  }

  const validation = validateReceipt(parsed);
  if (!validation.valid) {
    await rollbackState(tmpDir, state.sessionId);
    return toolResponse(
      state,
      [
        "❌ **Persona ExecutionReceipt 格式错误**",
        "",
        ...validation.errors.map((e: string) => `- ${e}`),
        ...(validation.warnings.length > 0 ? ["", "⚠️ 警告:"] : []),
        ...validation.warnings.map((w: string) => `- ${w}`),
        `当前重试次数：${(state.activeContinuation?.retryCount ?? 0) + 1}`,
      ].join("\n"),
    );
  }

  try {
    // ── Extract individual agent results from the aggregated receipt ──────
    const agentResults: Record<string, any> = {};

    if (parsed.agents && Array.isArray(parsed.agents)) {
      for (const agent of parsed.agents) {
        let output = agent.output;
        // Try to parse string output as JSON
        if (typeof output === "string") {
          try {
            output = JSON.parse(output.trim());
          } catch {
            // Keep as plain text if not JSON
          }
        }
        agentResults[agent.id] = output;
      }
    } else if (parsed.results && typeof parsed.results === "object") {
      // Alternative format: results keyed by agent id
      for (const [id, output] of Object.entries(parsed.results)) {
        agentResults[id] = output;
      }
    } else if (parsed.dimensions || parsed.personaId) {
      // Fallback: single agent result (simulated_agent mode)
      agentResults[parsed.personaId || "unknown"] = parsed;
    }

    // Build persona ID → display name map for the report
    const personaMap = new Map(personas.map((p) => [p.meta.id, p.meta.name]));

    // Build the combined report
    const reportParts: string[] = [
      "# 舆论仿真推演报告",
      "",
      `共 **${state.selectedPersonaIds.length}** 位评审员参与评测。`,
      "",
    ];

    let totalGreen = 0;
    let totalYellow = 0;
    let totalRed = 0;

    for (const persona of personas) {
      const pid = persona.meta.id;
      const result = agentResults[pid];

      reportParts.push(`## 👤 ${persona.meta.name}`);
      reportParts.push("");

      if (!result) {
        reportParts.push("⚠️ 该评审员未返回有效结果。");
        reportParts.push("");
        continue;
      }

      if (typeof result === "string") {
        reportParts.push(result);
        reportParts.push("");
        continue;
      }

      // Structured result
      const offDims = result.offensiveDimensions || [];
      const defDims = result.defensiveDimensions || [];

      // Count levels
      for (const d of [...offDims, ...defDims]) {
        if (d.level === "🟢") totalGreen++;
        else if (d.level === "🟡") totalYellow++;
        else if (d.level === "🔴") totalRed++;
      }

      // Offensive dimensions table
      if (offDims.length > 0) {
        reportParts.push("### 🚀 进攻性价值评估");
        reportParts.push("");
        reportParts.push("| 维度 | 等级 | 判定依据 |");
        reportParts.push("|------|------|---------|");
        for (const d of offDims) {
          reportParts.push(`| ${d.dimension} | ${d.level} | ${d.reasoning || "-"} |`);
        }
        reportParts.push("");
      }

      // Defensive dimensions summary
      if (defDims.length > 0) {
        reportParts.push("### 🛡️ 防御性风险评估");
        reportParts.push("");
        reportParts.push("| 维度 | 等级 | 判定依据 |");
        reportParts.push("|------|------|---------|");
        for (const d of defDims) {
          reportParts.push(`| ${d.dimension} | ${d.level} | ${d.reasoning || "-"} |`);
        }
        reportParts.push("");
      }

      if (result.overallConclusion) {
        reportParts.push(`**一句话总评**：${result.overallConclusion}`);
        reportParts.push("");
      }

      if (result.mostDestructiveRisk) {
        reportParts.push(`**最具破坏性风险**：${result.mostDestructiveRisk}`);
        reportParts.push("");
      }

      if (result.coreControversy) {
        reportParts.push(`**核心争议焦点**：${result.coreControversy}`);
        reportParts.push("");
      }

      if (result.simulatedReaction) {
        reportParts.push("### 💬 模拟用户反应");
        reportParts.push("");
        reportParts.push(`> ${result.simulatedReaction.replace(/\n/g, "\n> ")}`);
        reportParts.push("");
      }

      reportParts.push("---");
      reportParts.push("");
    }

    // Summary statistics
    if (totalGreen + totalYellow + totalRed > 0) {
      reportParts.push("## 📊 综合统计");
      reportParts.push("");
      reportParts.push(`- 🟢 安全：${totalGreen} 项`);
      reportParts.push(`- 🟡 注意：${totalYellow} 项`);
      reportParts.push(`- 🔴 风险：${totalRed} 项`);
      reportParts.push(`- 评审员参与：${Object.keys(agentResults).length}/${state.selectedPersonaIds.length} 位`);
      reportParts.push("");
    }

    if (state.tier === "free") {
      transitionState(state, "waitingForNextRound", "persona_audit_completed");
      state.usedPersonaIds = [...(state.usedPersonaIds || []), ...state.selectedPersonaIds];
      await saveState(tmpDir, state);
      const updateNote = await checkForUpdate().catch(() => null);
      const usedIds = new Set(state.usedPersonaIds || []);
      const remainingCount = personas.filter(p => !usedIds.has(p.meta.id)).length;
      const proActive = isPro();
      const proOption = proActive
        ? "- 继续多维评审（Pro）🔓"
        : "- 解锁六维风险检测 🔓（专业版）";
      const swapOption = remainingCount > 0
        ? `- 换一批评审员 — 从未参与本轮的角色中重新筛选（剩余 ${remainingCount} 位）`
        : "- 换一批评审员 — 所有评审员均已参与";
      const optionsText = [
        "<!-- kevlar:verbatim-options:start -->",
        "评测完成。是否继续？",
        swapOption,
        proOption,
        "- 结束评测",
        "<!-- kevlar:verbatim-options:end -->",
      ].join("\n");
      return toolResponse(
        state,
        reportParts.join("\n") + "\n\n---\n\n" + (updateNote ? updateNote + "\n\n" : "") + optionsText,
      );
    }

    transitionState(state, "completed", "persona_audit_completed");
    const updateNote = await checkForUpdate().catch(() => null);
    const response = toolResponse(
      state,
      reportParts.join("\n") + "\n\n---\n\n评测完成。" + (updateNote ?? ""),
    );
    await cleanupState(tmpDir, state.sessionId);
    return response;
  } catch (err) {
    const info = getErrorInfo(err);
    await rollbackState(tmpDir, state.sessionId);
    const errMsg = formatErrorWithReportPrompt(
      [
        "❌ 无法解析宿主 AI 返回的 Persona ExecutionReceipt。",
        `错误：${info.message}`,
        "请确保返回符合 protocol.ts 中 ExecutionReceipt 规格的 JSON 对象。",
      ].join("\n"),
      "review_content_wizard",
    );
    return toolResponse(state, errMsg);
  }
}

async function executeReview(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  // Load the selected personas
  const allPersonas = await loadAllPersonas(skillsDir);
  const selectedIds = new Set(state.selectedPersonaIds);
  const selectedPersonas = allPersonas.filter((p) => selectedIds.has(p.meta.id));

  if (selectedPersonas.length === 0) {
    return {
      content: [{ type: "text", text: "❌ 未找到选中的评审员。" }],
      isError: true,
    };
  }

  transitionState(state, "waitingForPersonaAudit", "persona_review_dispatched");
  setContinuation(state, "waitingForPersonaAudit", "persona_audit_started");

  // Build AgentBlueprint AFTER setContinuation so it reads the correct revision and continuationId
  const blueprint = buildPersonaAgentBlueprint(state, selectedPersonas);
  (state as any).blueprint = blueprint;

  await saveState(tmpDir, state);

  const isProTier = state.tier === "pro";

  const perAgentGuidance = isProTier ? [
    "",
    "### Pro option: submit per-agent results individually",
    "If your environment can submit results as each agent completes:",
    "1. Execute each persona agent independently",
    "2. For each completed agent, call `review_content_wizard_continue` with:",
    "   - The same sessionId, checkpoint, expectedRevision, continuationId",
    `   - \`agentId\`: the agent's ID (e.g., \`${blueprint.agents[0]?.id || "persona_1"}\`)`,
    "   - `result`: a JSON object with the agent's findings (agentId + status + output)",
    "3. Kevlar will auto-aggregate when all agents have reported",
    "",
  ].join("\n") : "";

  // Build agent list for explicit enumeration in prompt
  const personaListLines = blueprint.agents.map((a: any, i: number) =>
    `  ${i + 1}. \`${a.id}\``
  ).join("\n");
  const personaCount = blueprint.agents.length;

  const blueprintText = [
    "## Kevlar-4u Persona Review — Subagent Dispatch Request",
    "",
    // ── §1: Explicit mandatory requirement ──────────────────────────
    "### ⚠️ CRITICAL — You MUST create ALL subagents below",
    "",
    `This blueprint requires exactly **${personaCount} subagents**. You must create`,
    `every single one of them. **Skipping any agent will cause the receipt to be`,
    `REJECTED by Kevlar's validation gate.** The validation compares the receipt's`,
    `agent IDs against the blueprint and will fail if any are missing.`,
    "",
    "**The REQUIRED agents are:**",
    personaListLines,
    "",
    `**Total**: ${personaCount} subagents MUST be created and executed in parallel.`,
    "",
    "---",
    // ── §2: Phase 1 — Create all subagents ──────────────────────────
    "### Phase 1 — Create ALL subagents in parallel",
    "",
    "You MUST now create all subagents listed above. **Do not proceed to Phase 2",
    "until EVERY agent has returned its result.**",
    "",
    "**How to create subagents:**",
    "1. Read each agent's full definition in the AgentBlueprint JSON below",
    "2. Create one independent subagent per agent listed above",
    "3. Launch all subagents in **one message** (parallel dispatch)",
    "4. Each persona simulates a different audience perspective — isolate their context",
    "5. Wait for ALL results before proceeding",
    "",
    `**Expected in receipt**: exactly ${personaCount} agents with these IDs:`,
    `  ${blueprint.agents.map((a: any) => a.id).join(", ")}`,
    "",
    "**Reminder**: If you create fewer than all agents,",
    "the receipt will be REJECTED and you will waste a round-trip.",
    "",
    "---",
    // ── §3: Phase 2 — Aggregate and submit ──────────────────────────
    "### Phase 2 — Aggregate results and submit receipt",
    "",
    "**Only after ALL subagents have completed**, construct the ExecutionReceipt:",
    "",
    "1. Collect every agent's output (their `findings` array)",
    "2. Build the `agents` array with exactly one entry per agent — same ID",
    "3. Build the `aggregation` with one `dimensions` entry per agent (same IDs)",
    "4. Call `review_content_wizard_continue` with the complete receipt",
    "   (include sessionId, checkpoint, expectedRevision, and idempotencyKey as continuationId from the blueprint)",
    "",
    `The receipt MUST contain exactly ${personaCount} agent entries — no more, no less.`,
    "",
    "---",
    // ── §4: Anti-fabrication warning ──────────────────────────────
    "### ⛔ DO NOT FABRICATE OR INVENT AGENT OUTPUTS",
    "",
    "You MUST NOT fabricate, invent, or make up any agent's findings.",
    "Every finding in the receipt MUST come from the actual subagent's output.",
    "",
    "**If an agent failed to execute or did not return results:**",
    `- Set its \`status\` to \`"failed"\``,
    `- Set its \`output.findings\` to \`[]\` (empty array)`,
    `- In \`aggregation.dimensions\`, mark it as \`"⚠️ 未执行"\``,
    "",
    "**Falsifying agent results will corrupt the audit output** and may cause",
    "Kevlar to produce incorrect risk assessments. Always report truthfully.",
    "",
    "---",
    // ── §5: Receipt schema ──────────────────────────────────────────
    "### ExecutionReceipt Structure (kevlar.exec/v1)",
    "You MUST construct the receipt in EXACTLY this JSON shape:",
    "",
    "```",
    '{',
    '  "protocol": "kevlar.exec/v1",',
    '  "execution": {',
    '    "requestedMode": "ephemeral_agents",',
    '    "actualMode": "native_subagent",',
    `    "requestedConcurrency": ${personaCount},`,
    `    "actualConcurrency": ${personaCount},`,
    '    "contextIsolation": { "requested": true, "achieved": true },',
    '    "parallelism": "parallel",',
    '    "evidenceLevel": "host_attested"',
    '  },',
    '  "agents": [',
    '    {',
    '      "id": "<persona id from blueprint>",',
    '      "role": "persona_reviewer",',
    '      "status": "completed",',
    '      "output": {',
    '        "findings": [',
    '          {',
    '            "keyword": "风险词汇或争议点",',
    '            "trigger": "该 persona 视角的触发原因",',
    '            "riskDescription": "风险说明",',
    '            "suggestedLevel": "🔴 或 🟡",',
    '            "propagationPath": "传播路径",',
    '            "personaReaction": "该评审员的真实反应"',
    '          }',
    '        ]',
    '      }',
    '    }',
    '  ],',
    '  "aggregation": {',
    '    "dimensions": [',
    '      { "id": "<same persona id>", "level": "🟢/🟡/🔴", "findings": [] }',
    '    ],',
    '    "summary": "一句话总评"',
    '  }',
    '}',
    "```",
    "",
    "**Critical requirements:**",
    "- `agents[]` MUST contain exactly one entry per persona ID in the blueprint",
    "- `agents[].output` MUST be a JSON **object** (not a string) containing a `findings` array",
    "- `agents[].output.findings` MUST be an array (use `[]` if no findings)",
    "- Each persona already outputs a `findings` array — extract it directly as `agents[].output.findings`",
    "- `aggregation.dimensions` MUST be an array with one entry per persona (use same `id`)",
    "- `aggregation.summary` MUST be a string",
    "",
    perAgentGuidance,
    "### If you CANNOT execute subagent dispatch",
    "(e.g., your environment doesn't support parallel subagents)",
    "→ Call `review_content_wizard` again with the same sessionId:",
    `  \`sessionId\`: "${state.sessionId}"`,
    `  \`userMessage\`: "SEQUENTIAL_FALLBACK"`,
    "",
    "---",
    "### AgentBlueprint",
    "",
    "```json",
    JSON.stringify(blueprint, null, 2),
    "```",
  ].join("\n");

  return {
    content: [{
      type: "text",
      text: blueprintText,
    }],
  };
}

async function loadOrCreateState(tmpDir: string, input: ReviewWizardInput): Promise<ReviewWizardState> {
  if (input.sessionId && !isValidSessionId(input.sessionId)) {
    throw invalidInputError("sessionId 格式不合法。");
  }

  const sessionId = input.sessionId || `wizard-review-${Math.random().toString(36).substring(2, 10)}`;
  const statePath = getStatePath(tmpDir, sessionId);

  if (input.sessionId && fs.existsSync(statePath)) {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    const state = JSON.parse(raw) as ReviewWizardState;
    if (!state.dimensions) {
      state.dimensions = { ...DEFAULT_DIMENSIONS_CONFIG };
    }
    if (state.usedPersonaIds === undefined) state.usedPersonaIds = [];
    if (state.pendingPersonaIds === undefined) state.pendingPersonaIds = [];
    if (Date.now() - state.createdAt > 10 * 60 * 1000) {
      await cleanupState(tmpDir, sessionId);
      return {
        sessionId,
        createdAt: Date.now(),
        step: "waitingForRegionSelection",
        content: state.content,
        targetPlatforms: [],
        targetRegions: [],
        selectedPersonaIds: [],
        remainingPersonaIds: [],
        systemAuditorIds: [],
        dimensions: { ...DEFAULT_DIMENSIONS_CONFIG },
        usedPersonaIds: [],
        pendingPersonaIds: [],
      };
    }

    // Short TTL for waiting states: if the continuation has expired,
    // roll back to the last saved checkpoint and let the user retry.
    if (state.activeContinuation && state.activeContinuation.expiresAt < Date.now()) {
      const rolledBack = await rollbackState(tmpDir, sessionId);
      if (rolledBack && fs.existsSync(statePath)) {
        const raw = await fs.promises.readFile(statePath, "utf-8");
        const restoredState = JSON.parse(raw) as ReviewWizardState;
        restoredState.activeContinuation = undefined;
        restoredState.revision = (restoredState.revision ?? 0) + 1;
        restoredState.step = "waitingForRegionSelection";
        return restoredState;
      }
      // If rollback failed, still preserve state with content intact
      state.activeContinuation = undefined;
      state.revision = (state.revision ?? 0) + 1;
      state.step = "waitingForRegionSelection";
      return state;
    }
    if (!state.systemAuditorIds) {
      state.systemAuditorIds = [];
    }
    return state;
  }

  return {
    sessionId,
    createdAt: Date.now(),
    step: "waitingForRegionSelection",
    content: input.userMessage.trim(),
    targetPlatforms: [],
    targetRegions: [],
    selectedPersonaIds: [],
    remainingPersonaIds: [],
    systemAuditorIds: [],
    dimensions: { ...DEFAULT_DIMENSIONS_CONFIG },
    usedPersonaIds: [],
    pendingPersonaIds: [],
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
          `targetPlatforms: ${(state.targetPlatforms ?? []).join(", ") || "none"}`,
          `selectedPersonaIds: ${(state.selectedPersonaIds ?? []).join(", ") || "none"}`,
          `remainingPersonaIds: ${(state.remainingPersonaIds ?? []).join(", ") || "none"}`,
          `dimensions: defensive=${DEFENSIVE_DIMENSION_IDS.length}(system), offensive=${state.dimensions?.offensive?.length ?? 0}`,
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

function extractPositionContext(raw: string, errorPos: number, contextRadius = 200): string {
  const start = Math.max(0, errorPos - contextRadius);
  const end = Math.min(raw.length, errorPos + contextRadius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < raw.length ? "…" : "";
  return prefix + raw.slice(start, end) + suffix;
}

function resilientJsonParse(userMessage: string): any {
  const raw = stripCodeFence(userMessage.trim());

  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON5.parse(raw);
    } catch (json5Err: any) {
      let msg = `JSON 解析失败`;
      const posMatch = typeof json5Err?.message === "string"
        ? json5Err.message.match(/position (\d+)/)
        : null;

      if (posMatch) {
        const pos = parseInt(posMatch[1], 10);
        const context = extractPositionContext(raw, pos);
        msg += ` (位置 ${pos}):\n\`\`\`\n${context}\n\`\`\``;
      } else if (typeof json5Err?.message === "string") {
        msg += `: ${json5Err.message}`;
      }

      const err = new SyntaxError(msg);
      (err as any).code = "JSON_PARSE_ERROR";
      throw err;
    }
  }
}
