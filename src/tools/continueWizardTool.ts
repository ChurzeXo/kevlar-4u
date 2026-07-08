/**
 * Continuation Tool (v3)
 *
 * Provides a safe, versioned submission channel for host orchestration results.
 * Supports both batch (full receipt) and Pro per-agent slot-based submission.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import type { ToolModule, ToolDependencies } from "./types.js";
import { isValidSessionId } from "../utils/sessionId.js";
import { invalidInputError } from "../utils/errors.js";
import { formatErrorWithReportPrompt } from "../utils/errorReporting.js";
import { loadAllPersonas } from "../utils/parser.js";
import type { AuditCheckpoint } from "../execution/checkpoint.js";
import { MAX_CONTINUATION_RETRIES, validateContinuationGate, fallbackToStandardOrchestration } from "../execution/index.js";
import { rejected, degraded, formatStatusMessage } from "../execution/continuationStatus.js";
import {
  handleReviewContentWizard,
  type ReviewWizardInput,
  ORCHESTRATION_AUDIT_GUIDANCE,
  ORCHESTRATION_STEP0_GUIDANCE,
  buildSyntheticReceipt,
} from "./reviewContentWizardTool.js";
import { buildOrchestrationAuditPrompt, buildOrchestrationStep0Prompt } from "../prompts/reviewWizard.js";
import { validateSingleAgentResult } from "../execution/protocol.js";

// ── Tool Definition ───────────────────────────────────────────────────────────

export const reviewContentWizardContinueDefinition: Tool = {
  name: "review_content_wizard_continue",
  description:
    "提交宿主编排执行结果并继续审计流程。" +
    "与 review_content_wizard 不同，此工具使用 session checkpoint + revision 协议确保结果一致性，" +
    "防止旧回合覆盖新状态。当 Kevlar 返回 continuation contract 时，必须使用此工具提交结果。" +
    "Pro 用户可通过 contextId 逐 context 提交结果，Kevlar 自动聚合。",

  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Kevlar 返回的会话 ID（来自延续合同）",
      },
      checkpoint: {
        type: "string",
        description: "当前检查点（如 step0_completed、preaudit_completed）",
        enum: [
          "initiated",
          "step0_completed",
          "preaudit_started",
          "preaudit_completed",
          "persona_inventory_completed",
          "persona_audit_started",
        ],
      },
      expectedRevision: {
        type: "number",
        description: "会话的预期版本号。Kevlar 返回 continuation contract 时提供。",
      },
      continuationId: {
        type: "string",
        description: "延续 ID。Kevlar 返回 continuation contract 时提供。",
      },
      result: {
        type: "string",
        description: "执行结果。可以是 JSON 结构或自然语言文本。",
      },
      receipt: {
        type: "object",
        description: "符合 kevlar.blueprint/v1 协议的 ExecutionReceipt 结构体",
      },
      contextId: {
        type: "string",
        description:
          "Pro only: context ID for per-context slot submission. " +
          "When present, Kevlar saves the result to the agent slot and auto-aggregates when all slots filled. " +
          "Must match an contextId from the blueprint's contextSlots.contextIds.",
      },
    },
    required: ["sessionId", "checkpoint", "expectedRevision", "continuationId"],
  },
};

// ── Handler ───────────────────────────────────────────────────────────────────

export const reviewContentWizardContinueModule: ToolModule = {
  definition: reviewContentWizardContinueDefinition,
  handler: (deps: ToolDependencies) => async (args) => {
    if (!args) throw invalidInputError("需要提供参数");

    const sessionId = args.sessionId as string;
    const checkpoint = args.checkpoint as AuditCheckpoint;
    const expectedRevision = args.expectedRevision as number;
    const continuationId = args.continuationId as string;
    const result = args.result as string | undefined;
    const receiptInput = args.receipt as any;
    const contextId = args.contextId as string | undefined;

    if (!sessionId || typeof sessionId !== "string") {
      return {
        content: [{ type: "text", text: formatStatusMessage(rejected("missing_session_id"), "❌ 缺少 sessionId。") }],
        isError: true,
      };
    }

    if (!isValidSessionId(sessionId)) {
      return {
        content: [{ type: "text", text: formatStatusMessage(rejected("invalid_session_id_format"), "❌ 无效的 sessionId 格式。") }],
        isError: true,
      };
    }

    // ── Load wizard state ──────────────────────────────────────────────────
    const statePath = path.join(deps.tmpDir, `${sessionId}_review_wizard.json`);
    let state: any;
    try {
      const raw = await fs.promises.readFile(statePath, "utf-8");
      state = JSON.parse(raw);
    } catch {
      const msg = formatStatusMessage(rejected("session_expired"), "❌ 未找到此 session 的状态文件，会话可能已过期。");
      return {
        content: [{ type: "text", text: formatErrorWithReportPrompt(msg, "review_content_wizard_continue") }],
        isError: true,
      };
    }

    // Parse receipt if in string form
    let receipt = receiptInput;
    if (!receipt && result) {
      try {
        receipt = JSON.parse(result.trim());
      } catch {
        receipt = null;
      }
    }

    // ── Pro: Slot-based per-agent submission ─────────────────────────────
    if (contextId) {
      return await handleContextSlot(
        deps, state, statePath, sessionId, expectedRevision, continuationId, contextId, receipt, result,
      );
    }

    // ── Standard batch submission (full receipt) ─────────────────────────
    // ── validateContinuationGate Integration ───────────────────────────────
    if (state.step === "waitingForSubagentAudit" || state.step === "waitingForPersonaAudit") {
      try {
        const validationResult = validateContinuationGate(state, {
          continuationId,
          expectedRevision,
          receipt,
        });

        if (validationResult.status === "invalid") {
          const tmpPath = statePath + ".tmp";
          await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
          await fs.promises.rename(tmpPath, statePath);

          const detailedReasons = validationResult.risk.reasons.length > 0
            ? "\n\n**验证失败详情：**\n" + validationResult.risk.reasons.map((r) => `- ${r}`).join("\n")
            : "";

          // §4.3: If agents are simply missing (schema is otherwise valid),
          // reject with clear instructions — do NOT auto-downgrade yet.
          const missingIds = validationResult.missingContextIds;
          if (missingIds && missingIds.length > 0 && validationResult.checks.schemaValid) {
            const blueprintAgents = (state as any).blueprint?.contexts || [];
            // Build a clear rejection telling the host EXACTLY which agents are missing
            const missingList = missingIds.map((id: string) => {
              const agentDef = blueprintAgents.find((a: any) => a.id === id);
              return `- \`${id}\`${agentDef ? ` (${agentDef.role})` : ""}`;
            }).join("\n");
            const totalExpected = blueprintAgents.length > 0 ? blueprintAgents.length : 6;
            const currentCount = (receipt?.contexts || []).length;

            const errMsg = [
              "⛔ **Receipt 被拒绝** — 你提交的 ExecutionReceipt 缺少必需的 context。",
              "",
              `**蓝图要求**：${totalExpected} 个 subagent`,
              `**实际提交**：${currentCount} 个 agent（缺少 ${missingIds.length} 个）`,
              "",
              "**缺失的 agent：**",
              missingList,
              "",
              "**下一步操作：**",
              `1. 创建以上 ${missingIds.length} 个缺失的 subagent（每个 agent 的 blueprint 见之前的 Dispatch Request）`,
              "2. 等待全部 agent 执行完毕",
              "3. 将所有 agent 的结果聚合为完整的 ExecutionReceipt",
              "4. 重新调用 `review_content_wizard_continue` 提交完整 receipt",
              "",
              `⚠️ 注意：你还有 ${Math.max(0, 3 - ((state.activeContinuation?._receiptRetries ?? 0)))} 次重试机会。`,
              "超过重试次数后，Kevlar 将自动降级为串行编排模式。",
              detailedReasons,
            ].join("\n");
            return {
              content: [{
                type: "text",
                text: formatStatusMessage(
                  rejected("incomplete_execution_receipt", { missing: missingIds, totalExpected, currentCount }),
                  errMsg,
                ) + "\n\n" + formatErrorWithReportPrompt(
                  "Incomplete ExecutionReceipt — missing agents",
                  "review_content_wizard_continue",
                ),
              }],
            };
          }

          if (state.step === "waitingForPersonaAudit") {
            const errMsg = [
              "⛔ **并行评审执行失败** — 宿主 AI 未返回有效的 ExecutionReceipt。",
              "",
              "可能的原因：",
              "- 宿主 AI 不支持 Subagent 并行调度",
              "- 返回的 JSON 格式不符合 kevlar.blueprint/v1 协议",
              detailedReasons,
              "",
              "如果你的环境不支持并行 Subagent 调度，",
              "请调用 `review_content_wizard`（注意不是 _continue）并发送内容：`SEQUENTIAL_FALLBACK`",
              "Kevlar 将退出并行调度流程，让你重新选择评审员。",
              "",
              "或者你可以修正 Receipt 格式后通过 `review_content_wizard_continue` 重试。",
            ].join("\n");
            return {
              content: [{
                type: "text",
                text: formatStatusMessage(
                  rejected("invalid_execution_receipt"),
                  errMsg,
                ) + "\n\n" + formatErrorWithReportPrompt(
                  "Parallel execution receipt validation failed",
                  "review_content_wizard_continue",
                ),
              }],
            };
          }

          const allPersonas = await loadAllPersonas(deps.skillsDir);
          const systemAuditors = allPersonas.filter((p) => p.meta.tags.includes("system_auditor"));
          let promptText = formatStatusMessage(
            degraded("schema_mismatch", {
              sessionId: state.sessionId,
              revision: state.revision,
              continuationId: state.activeContinuation?.continuationId,
            }),
            "结构化协作执行未返回可验证结果，已自动切换为标准宿主编排模式。" +
            (detailedReasons ? "\n\n" + detailedReasons : ""),
          ) + "\n";

          if (state.step === "waitingForOrchestrationAudit") {
            promptText += ORCHESTRATION_AUDIT_GUIDANCE + buildOrchestrationAuditPrompt(state.content, systemAuditors, state.orchestrationPreAuditContext);
          } else {
            promptText += ORCHESTRATION_STEP0_GUIDANCE + buildOrchestrationStep0Prompt(state.content, state.orchestrationPreAuditContext?.localFindings ?? [], state.orchestrationPreAuditContext?.stripped);
          }

          const responseText = [
            promptText,
            "",
            "---",
            `会话 ID：${state.sessionId}`,
            `预期版本：${state.revision}`,
            `延续 ID：${state.activeContinuation?.continuationId}`,
            "",
            formatErrorWithReportPrompt(
              "结构化协作执行未返回可验证结果 (schema_mismatch)",
              "review_content_wizard_continue",
            ),
          ].join("\n");

          return {
            content: [{ type: "text", text: responseText }],
          };
        }
      } catch (err: any) {
        const isStaleContinuation = String(err.message || "").includes("stale_continuation_revision_locked");
        const recoveryHint = isStaleContinuation
          ? "\n\n💡 会话已过期（并行审核耗时过长）。请用相同 sessionId 重新调用 review_content_wizard，系统将从断点自动恢复。"
          : "";
        const msg = formatStatusMessage(
          rejected("gate_validation_failed", { error: err.message }),
          `❌ 门禁验证失败：${err.message}${recoveryHint}`,
        );
        return {
          content: [{ type: "text", text: formatErrorWithReportPrompt(msg, "review_content_wizard_continue") }],
          isError: true,
        };
      }
    } else {
      // ContinuationId format validation (§7.1)
      const CONTINUATION_ID_RE = /^[a-z0-9-]+$/;
      if (typeof continuationId !== "string" || !CONTINUATION_ID_RE.test(continuationId)) {
        return {
          content: [{ type: "text", text: formatStatusMessage(
            rejected("invalid_continuation_id_format"),
            `❌ continuationId 格式不合法: "${continuationId}"。仅允许 [a-z0-9-]+`,
          ) }],
          isError: true,
        };
      }

      // Standard/Legacy Continuation Checks (fallback steps)
      if (typeof state.revision !== "number") {
        state.revision = 1;
      }

      if (state.revision !== expectedRevision) {
        return {
          content: [
            {
              type: "text",
              text: formatStatusMessage(
                rejected("stale_revision", { currentRevision: state.revision, expectedRevision }),
                [
                  "⛔ **Stale Continuation** — 此延续已过期。",
                  "",
                  `- 预期版本：${expectedRevision}`,
                  `- 当前版本：${state.revision}`,
                  `- 延续 ID：${continuationId}`,
                  "",
                  "会话状态已被更近的操作更新。请使用最新的 continuation contract 重试。",
                ].join("\n"),
              ),
            },
          ],
          isError: true,
        };
      }

      const activeContinuation = state.activeContinuation;
      if (!activeContinuation) {
        return {
          content: [{ type: "text", text: formatStatusMessage(rejected("no_active_continuation"), "❌ 此会话没有活动的延续请求。") }],
          isError: true,
        };
      }

      if (activeContinuation.continuationId !== continuationId) {
        return {
          content: [
            {
              type: "text",
              text: formatStatusMessage(
                rejected("continuation_id_mismatch", { expected: activeContinuation.continuationId, received: continuationId }),
                [
                  "⛔ **Continuation ID 不匹配**",
                  `期望：${activeContinuation.continuationId}`,
                  `收到：${continuationId}`,
                ].join("\n"),
              ),
            },
          ],
          isError: true,
        };
      }

      if (activeContinuation.checkpoint !== checkpoint) {
        return {
          content: [
            {
              type: "text",
              text: formatStatusMessage(
                rejected("checkpoint_mismatch", { expected: activeContinuation.checkpoint, received: checkpoint }),
                [
                  "⛔ **Checkpoint 不匹配**",
                  `期望：${activeContinuation.checkpoint}`,
                  `收到：${checkpoint}`,
                ].join("\n"),
              ),
            },
          ],
          isError: true,
        };
      }

      if (activeContinuation.expiresAt < Date.now()) {
        // Graceful degradation: expired continuation → fallback to L3 (§4.4)
        fallbackToStandardOrchestration(state, "continuation_expired");
        const tmpPath = statePath + ".tmp";
        await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
        await fs.promises.rename(tmpPath, statePath);

        const allPersonas = await loadAllPersonas(deps.skillsDir);
        const systemAuditors = allPersonas.filter((p) => p.meta.tags.includes("system_auditor"));
        const localFindings = state.orchestrationPreAuditContext?.localFindings ?? [];
        const stripped = state.orchestrationPreAuditContext?.stripped;
        const promptText = ORCHESTRATION_STEP0_GUIDANCE + buildOrchestrationStep0Prompt(
          state.content, localFindings, stripped,
        );

        return {
          content: [{
            type: "text",
            text: [
              formatStatusMessage(
                degraded("continuation_expired", {
                  sessionId: state.sessionId,
                  revision: state.revision,
                  continuationId: state.activeContinuation?.continuationId,
                }),
                "⏰ **延续请求已过期** — 已自动降级到标准宿主编排模式。",
              ),
              "",
              promptText,
              "",
              "---",
              `会话 ID：${state.sessionId}`,
              `预期版本：${state.revision}`,
              `延续 ID：${state.activeContinuation?.continuationId}`,
            ].join("\n"),
          }],
        };
      }

      // Retry limit: after 3 failed attempts, auto-degrade to L3 orchestration (§6.3)
      const retryCount = (activeContinuation.retryCount ?? 0) + 1;
      activeContinuation.retryCount = retryCount;
      if (retryCount > MAX_CONTINUATION_RETRIES) {
        fallbackToStandardOrchestration(state, "max_retries_exceeded");
        const tmpPath = statePath + ".tmp";
        await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
        await fs.promises.rename(tmpPath, statePath);

        const allPersonas = await loadAllPersonas(deps.skillsDir);
        const systemAuditors = allPersonas.filter((p) => p.meta.tags.includes("system_auditor"));
        const localFindings = state.orchestrationPreAuditContext?.localFindings ?? [];
        const stripped = state.orchestrationPreAuditContext?.stripped;
        const promptText = ORCHESTRATION_STEP0_GUIDANCE + buildOrchestrationStep0Prompt(
          state.content, localFindings, stripped,
        );

        return {
          content: [{
            type: "text",
            text: [
              formatStatusMessage(
                degraded("max_retries_exceeded", {
                  sessionId: state.sessionId,
                  revision: state.revision,
                  continuationId: state.activeContinuation?.continuationId,
                  maxRetries: MAX_CONTINUATION_RETRIES,
                }),
                `🛑 **已达最大重试次数（${MAX_CONTINUATION_RETRIES} 次）** — 已自动降级到标准宿主编排模式。`,
              ),
              "",
              promptText,
              "",
              "---",
              `会话 ID：${state.sessionId}`,
              `预期版本：${state.revision}`,
              `延续 ID：${state.activeContinuation?.continuationId}`,
            ].join("\n"),
          }],
        };
      }
    }

    // ── Accept continuation ──────────────────────────────────────────────
    state.revision += 1;
    state.activeContinuation = undefined;
    const tmpPath = statePath + ".tmp";
    await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    await fs.promises.rename(tmpPath, statePath);

    // Route the result through the wizard using userMessage flow.
    const wizardInput: ReviewWizardInput = {
      sessionId,
      userMessage: typeof receipt === "object" ? JSON.stringify(receipt) : result || "",
      samplingFn: deps.resolveSamplingFn(),
      sendProgress: deps.sendProgress,
      strategyProvider: deps.strategyProvider,
    };

    return await handleReviewContentWizard(deps.skillsDir, deps.tmpDir, wizardInput);
  },
};

// ── Slot-Based Per-Agent Submission Handler (Pro) ───────────────────────────

async function handleContextSlot(
  deps: ToolDependencies,
  state: any,
  statePath: string,
  sessionId: string,
  expectedRevision: number,
  continuationId: string,
  contextId: string,
  receipt: any,
  result: string | undefined,
): Promise<ToolResult> {
  // ── Step check ──────────────────────────────────────────────────────────
  if (state.step !== "waitingForSubagentAudit" && state.step !== "waitingForPersonaAudit") {
    return {
      content: [{
        type: "text",
        text: formatStatusMessage(
          rejected("invalid_step", { currentStep: state.step }),
          `❌ 当前步骤不支持逐 context 提交（当前步骤: ${state.step}）。仅在 waitingForSubagentAudit 或 waitingForPersonaAudit 步骤可用。`,
        ),
      }],
      isError: true,
    };
  }

  // ── Tier check (Pro only) ───────────────────────────────────────────────
  if (state.tier !== "pro") {
    return {
      content: [{ type: "text", text: formatStatusMessage(rejected("pro_only"), "❌ 逐 context 提交仅限 Pro 用户。请使用 batch 方式（全量 receipt）提交。") }],
      isError: true,
    };
  }

  // ── Continuation validation (Gates 1 & 2 only: revision + continuationId) ─
  // continuationId format validation (§7.1)
  const CONT_SLOT_ID_RE = /^[a-z0-9-]+$/;
  if (typeof continuationId !== "string" || !CONT_SLOT_ID_RE.test(continuationId)) {
    return {
      content: [{ type: "text", text: formatStatusMessage(rejected("invalid_continuation_id_format"), `❌ continuationId 格式不合法。仅允许 [a-z0-9-]+`) }],
      isError: true,
    };
  }

  // For slot-based submissions, state.revision increments on each write (§4.5).
  // Accept any submission where continuationId matches and the host's
  // expectedRevision is >= the blueprint's original revision.
  const blueprintRevision = state.activeContinuation?._blueprintRevision
    ?? state.activeContinuation?.expectedRevisionOverride
    ?? expectedRevision;
  if (expectedRevision < blueprintRevision) {
    return {
      content: [{
        type: "text",
        text: formatStatusMessage(
          rejected("stale_revision", { blueprintRevision, expectedRevision }),
          [
            "⛔ **Stale Continuation** — revision 落后于蓝图版本。",
            `当前蓝图版本: ${blueprintRevision}, 提交版本: ${expectedRevision}`,
            "请使用蓝图返回的 expectedRevision。",
          ].join("\n"),
        ),
      }],
      isError: true,
    };
  }

  if (!state.activeContinuation || state.activeContinuation.continuationId !== continuationId) {
    return {
      content: [{
        type: "text",
        text: formatStatusMessage(rejected("continuation_id_mismatch"), "⛔ **Continuation ID 不匹配**"),
      }],
      isError: true,
    };
  }

  // ── Continuation expiry → slot deadline auto-finalize ────────────────────
  const isExpired = state.activeContinuation.expiresAt < Date.now();

  // ── Agent ID format validation (§7.1) ─────────────────────────────────────
  const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/;
  if (!AGENT_ID_RE.test(contextId)) {
    return {
      content: [{
        type: "text",
        text: formatStatusMessage(
          rejected("invalid_context_id_format", { contextId }),
          `❌ contextId 格式不合法: "${contextId}"。仅允许 [a-zA-Z0-9_-]+`,
        ),
      }],
      isError: true,
    };
  }

  // ── Agent ID validation ──────────────────────────────────────────────────
  const blueprint = (state as any).blueprint;
  const expectedContextIds: string[] = blueprint?.continuation?.contextSlots?.contextIds ?? [];
  if (expectedContextIds.length > 0 && !expectedContextIds.includes(contextId)) {
    return {
      content: [{
        type: "text",
        text: formatStatusMessage(
          rejected("unknown_context_id", { contextId, expectedContextIds }),
          `❌ 未知的 contextId "${contextId}"。期望: ${expectedContextIds.join(", ")}`,
        ),
      }],
      isError: true,
    };
  }

  // ── Parse slot result ────────────────────────────────────────────────────
  let parsedResult: any = receipt;
  if (!parsedResult && result) {
    try {
      parsedResult = JSON.parse(result.trim());
    } catch { /* null */ }
  }

  if (!parsedResult || typeof parsedResult !== "object") {
    return {
      content: [{ type: "text", text: formatStatusMessage(rejected("invalid_json"), "❌ Context 结果必须是有效的 JSON 对象（通过 receipt 或 result 字段）。") }],
      isError: true,
    };
  }

  // ── Validate single agent result ─────────────────────────────────────────
  const validation = validateSingleAgentResult(contextId, parsedResult);
  if (!validation.valid) {
    return {
      content: [
        {
          type: "text",
          text: formatStatusMessage(
            rejected("context_result_format_error", { contextId, errors: validation.errors, warnings: validation.warnings }),
            [
              "❌ **Context 结果格式错误**",
              "",
              ...validation.errors.map((e: string) => `- ${e}`),
              ...(validation.warnings.length > 0 ? ["", "⚠️ 警告:"] : []),
              ...validation.warnings.map((w: string) => `- ${w}`),
            ].join("\n"),
          ),
        },
      ],
      isError: true,
    };
  }

  // ── Write to slot ────────────────────────────────────────────────────────
  const total = blueprint?.continuation?.contextSlots?.total ?? expectedContextIds.length;
  if (!state.contextSlots) {
    state.contextSlots = { total, received: {} };
  }

  // Re-submission check — warn but allow overwrite
  const isResubmit = !!state.contextSlots.received[contextId];
  if (!isResubmit && Object.keys(state.contextSlots.received).length >= total) {
    // Edge case: slot already full
    return {
      content: [{
        type: "text",
        text: formatStatusMessage(rejected("slots_full", { total }), `⚠️ 所有 ${total} 个 context 槽位已满，无法提交更多结果。`),
      }],
      isError: true,
    };
  }

  const outputFindings = parsedResult.output?.findings
    || parsedResult.result?.findings
    || parsedResult.findings
    || [];
  const outputOutput = parsedResult.output || parsedResult.result || {};
  const status = parsedResult.status || "completed";

  state.contextSlots.received[contextId] = {
    contextId,
    status,
    submittedAt: Date.now(),
    output: {
      findings: Array.isArray(outputFindings) ? outputFindings : [],
      reasoning: outputOutput.reasoning || parsedResult.reasoning || "",
    },
  };

  // §4.5: Increment revision on each slot write for audit trail
  state.revision = (state.revision ?? 0) + 1;
  // Preserve the original blueprint revision so subsequent submissions can
  // reference any revision >= the blueprint's baseline.
  if (state.activeContinuation && !state.activeContinuation._blueprintRevision) {
    state.activeContinuation._blueprintRevision = expectedRevision;
  }

  // ── Check if all slots filled ────────────────────────────────────────────
  const receivedIds = new Set(Object.keys(state.contextSlots.received));
  const allFilled = expectedContextIds.length > 0
    && expectedContextIds.every((id: string) => receivedIds.has(id));

  // Compute completed vs failed counts
  const receivedSlots = Object.values(state.contextSlots.received) as any[];
  const completedCount = receivedSlots.filter((s: any) => s.status === "completed").length;
  const failedCount = receivedSlots.filter((s: any) => s.status !== "completed").length;

  // Save state after slot write
  const tmpPath = statePath + ".tmp";
  await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  await fs.promises.rename(tmpPath, statePath);

  // ── Phase 4: Slot deadline auto-finalize ─────────────────────────────────
  // If the continuation has expired, force partial aggregation with
  // whatever results are available (accepted agents only).
  if (isExpired && !allFilled) {
    return await finalizeSlots(deps, state, statePath, sessionId, total, completedCount, contextId);
  }

  if (!allFilled) {
    const remaining = expectedContextIds.filter((id: string) => !receivedIds.has(id));
    const progressParts: string[] = [
      `✅ 已收到 context **"${contextId}"** 的审计结果。`,
    ];
    if (isResubmit) progressParts.push("（覆盖先前提交的结果）");
    if (failedCount > 0) {
      progressParts.push(`完成: ${completedCount}/${total}, 失败: ${failedCount}/${total}`);
    } else {
      progressParts.push(`进度: ${receivedIds.size}/${total} 个 context 已提交。`);
    }
    if (remaining.length > 0) {
      progressParts.push(`等待: ${remaining.join(", ")}`);
    }
    progressParts.push(
      "",
      "使用相同的 sessionId, checkpoint, continuationId",
      `expectedRevision: ${state.revision}`,
      "继续提交其他 agent 结果。",
    );
    return {
      content: [{ type: "text", text: progressParts.join("\n") }],
    };
  }

  // ── All slots filled — check if any completed ────────────────────────────
  if (completedCount === 0) {
    return {
      content: [{
        type: "text",
        text: formatStatusMessage(
          rejected("all_contexts_failed", { total }),
          [
            "❌ **全部 context 执行失败，无法聚合。**",
            "",
            `共 ${total} 个 context，全部返回 status: "failed"。`,
            "请检查内容或宿主环境后重试。",
          ].join("\n"),
        ),
      }],
      isError: true,
    };
  }

  // ── All slots filled (or expired + partial) — auto-aggregate ─────────────
  return await finalizeSlots(deps, state, statePath, sessionId, total, completedCount, contextId);
}

/**
 * Build synthetic receipt from available slot results and route through wizard.
 */
async function finalizeSlots(
  deps: ToolDependencies,
  state: any,
  statePath: string,
  sessionId: string,
  total: number,
  completedCount: number,
  lastContextId: string,
): Promise<ToolResult> {
  if (completedCount === 0) {
    return {
      content: [{
        type: "text",
        text: formatStatusMessage(
          rejected("all_contexts_failed", { total }),
          [
            "❌ **没有可用的 context 结果，无法聚合。**",
            "",
            `共 ${total} 个 context，全部返回 status: "failed" 或未提交。`,
            "请检查内容或宿主环境后重试。",
          ].join("\n"),
        ),
      }],
      isError: true,
    };
  }

  const allPersonas = await loadAllPersonas(deps.skillsDir);
  const auditors = state.step === "waitingForPersonaAudit"
    ? allPersonas.filter((p) => !p.meta.tags.includes("system_auditor"))
    : allPersonas.filter((p) => p.meta.tags.includes("system_auditor"));

  let syntheticReceipt: any;
  try {
    syntheticReceipt = buildSyntheticReceipt(
      state.contextSlots.received,
      auditors,
    );
  } catch (err: any) {
    const msg = formatStatusMessage(
      rejected("context_result_format_error", { error: err.message }),
      `❌ 自动聚合失败：${err.message}`,
    );
    return {
      content: [{
        type: "text",
        text: formatErrorWithReportPrompt(msg, "review_content_wizard_continue"),
      }],
      isError: true,
    };
  }

  // Finalize: increment revision, clear continuation
  state.revision += 1;
  state.activeContinuation = undefined;
  const finalTmpPath = statePath + ".tmp";
  await fs.promises.writeFile(finalTmpPath, JSON.stringify(state, null, 2), "utf-8");
  await fs.promises.rename(finalTmpPath, statePath);

  // Route through wizard for auto-processing (mergeLocalFindingsIntoAudits + calculateSynergy)
  const wizardInput: ReviewWizardInput = {
    sessionId,
    userMessage: JSON.stringify(syntheticReceipt),
    samplingFn: deps.resolveSamplingFn(),
    sendProgress: deps.sendProgress,
    strategyProvider: deps.strategyProvider,
  };

  return await handleReviewContentWizard(deps.skillsDir, deps.tmpDir, wizardInput);
}
