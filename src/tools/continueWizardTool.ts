/**
 * Continuation Tool (v3)
 *
 * Provides a safe, versioned submission channel for host orchestration results.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import type { ToolModule, ToolDependencies } from "./types.js";
import { isValidSessionId } from "../utils/sessionId.js";
import { loadAllPersonas } from "../utils/parser.js";
import type { AuditCheckpoint } from "../execution/checkpoint.js";
import { MAX_CONTINUATION_RETRIES, validateContinuationGate } from "../execution/index.js";
import { handleReviewContentWizard, type ReviewWizardInput } from "./reviewContentWizardTool.js";

// ── Tool Definition ───────────────────────────────────────────────────────────

export const reviewContentWizardContinueDefinition: Tool = {
  name: "review_content_wizard_continue",
  description:
    "提交宿主编排执行结果并继续审计流程。" +
    "与 review_content_wizard 不同，此工具使用 session checkpoint + revision 协议确保结果一致性，" +
    "防止旧回合覆盖新状态。当 Kevlar 返回 continuation contract 时，必须使用此工具提交结果。",

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
        description: "符合 kevlar.exec/v1 协议的 ExecutionReceipt 结构体",
      },
    },
    required: ["sessionId", "checkpoint", "expectedRevision", "continuationId"],
  },
};

// ── Handler ───────────────────────────────────────────────────────────────────

export const reviewContentWizardContinueModule: ToolModule = {
  definition: reviewContentWizardContinueDefinition,
  handler: (deps: ToolDependencies) => async (args) => {
    if (!args) throw new Error("需要提供参数");

    const sessionId = args.sessionId as string;
    const checkpoint = args.checkpoint as AuditCheckpoint;
    const expectedRevision = args.expectedRevision as number;
    const continuationId = args.continuationId as string;
    const result = args.result as string | undefined;
    const receiptInput = args.receipt as any;

    if (!sessionId || typeof sessionId !== "string") {
      return {
        content: [{ type: "text", text: "❌ 缺少 sessionId。" }],
        isError: true,
      };
    }

    if (!isValidSessionId(sessionId)) {
      return {
        content: [{ type: "text", text: "❌ 无效的 sessionId 格式。" }],
        isError: true,
      };
    }

    // Load wizard state
    const statePath = path.join(deps.tmpDir, `${sessionId}_review_wizard.json`);
    let state: any;
    try {
      const raw = await fs.promises.readFile(statePath, "utf-8");
      state = JSON.parse(raw);
    } catch {
      return {
        content: [{ type: "text", text: "❌ 未找到此 session 的状态文件，会话可能已过期。" }],
        isError: true,
      };
    }

    // Parse receipt if in subagent audit phase
    let receipt = receiptInput;
    if (!receipt && result) {
      try {
        receipt = JSON.parse(result.trim());
      } catch {
        receipt = null;
      }
    }

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

          // Persona audit has no orchestration fallback — abort cleanly
          if (state.step === "waitingForPersonaAudit") {
            return {
              content: [{
                type: "text",
                text: [
                  "⛔ **并行评审执行失败** — 宿主 AI 未返回有效的 ExecutionReceipt。",
                  "",
                  "可能的原因：",
                  "- 宿主 AI 不支持 Subagent 并行调度",
                  "- 返回的 JSON 格式不符合 kevlar.persona-review/v1 协议",
                  "",
                  "建议：请使用其他 MCP 客户端（如支持 Task/Subagent 工具的客户端）重试。",
                ].join("\n"),
              }],
              isError: true,
            };
          }

          const allPersonas = await loadAllPersonas(deps.skillsDir);
          const systemAuditors = allPersonas.filter((p) => p.meta.tags.includes("system_auditor"));
          let promptText = "结构化协作执行未返回可验证结果，已自动切换为标准宿主编排模式。\n";
          
          if (state.step === "waitingForOrchestrationAudit") {
            const { ORCHESTRATION_AUDIT_GUIDANCE } = await import("./reviewContentWizardTool.js");
            const { buildOrchestrationAuditPrompt } = await import("../prompts/reviewWizard.js");
            promptText += ORCHESTRATION_AUDIT_GUIDANCE + buildOrchestrationAuditPrompt(state.content, systemAuditors, state.orchestrationPreAuditContext);
          } else {
            const { ORCHESTRATION_STEP0_GUIDANCE } = await import("./reviewContentWizardTool.js");
            const { buildOrchestrationStep0Prompt } = await import("../prompts/reviewWizard.js");
            promptText += ORCHESTRATION_STEP0_GUIDANCE + buildOrchestrationStep0Prompt(state.content, state.orchestrationPreAuditContext?.localFindings ?? [], state.orchestrationPreAuditContext?.stripped);
          }

          const responseText = [
            promptText,
            "",
            "---",
            `会话 ID：${state.sessionId}`,
            `预期版本：${state.revision}`,
            `延续 ID：${state.activeContinuation?.continuationId}`,
          ].join("\n");

          return {
            content: [{ type: "text", text: responseText }],
          };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `❌ 门禁验证失败：${err.message}` }],
          isError: true,
        };
      }
    } else {
      // Standard/Legacy Continuation Checks (fallback steps)
      if (typeof state.revision !== "number") {
        state.revision = 1;
      }

      if (state.revision !== expectedRevision) {
        return {
          content: [
            {
              type: "text",
              text: [
                "⛔ **Stale Continuation** — 此延续已过期。",
                "",
                `- 预期版本：${expectedRevision}`,
                `- 当前版本：${state.revision}`,
                `- 延续 ID：${continuationId}`,
                "",
                "会话状态已被更近的操作更新。请使用最新的 continuation contract 重试。",
              ].join("\n"),
            },
          ],
          isError: true,
        };
      }

      const activeContinuation = state.activeContinuation;
      if (!activeContinuation) {
        return {
          content: [{ type: "text", text: "❌ 此会话没有活动的延续请求。" }],
          isError: true,
        };
      }

      if (activeContinuation.continuationId !== continuationId) {
        return {
          content: [
            {
              type: "text",
              text: [
                "⛔ **Continuation ID 不匹配**",
                `期望：${activeContinuation.continuationId}`,
                `收到：${continuationId}`,
              ].join("\n"),
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
              text: [
                "⛔ **Checkpoint 不匹配**",
                `期望：${activeContinuation.checkpoint}`,
                `收到：${checkpoint}`,
              ].join("\n"),
            },
          ],
          isError: true,
        };
      }

      if (activeContinuation.expiresAt < Date.now()) {
        return {
          content: [{ type: "text", text: "❌ 延续请求已过期，请重新发起审计。" }],
          isError: true,
        };
      }

      // Retry limit: after 3 failed attempts, auto-degrade to avoid infinite loops
      const retryCount = (activeContinuation.retryCount ?? 0) + 1;
      activeContinuation.retryCount = retryCount;
      if (retryCount > MAX_CONTINUATION_RETRIES) {
        // Clean up state so user can restart
        try { await fs.promises.unlink(statePath); } catch { /* ok */ }
        return {
          content: [{
            type: "text",
            text: [
              `🛑 **已达最大重试次数（${MAX_CONTINUATION_RETRIES} 次）** — 会话已自动终止。`,
              "",
              "可能的原因：",
              "- 宿主 AI 连续返回格式不正确的 ExecutionReceipt",
              "- Subagent 调度能力不足",
              "",
              "建议：重新发起评测流程。",
            ].join("\n"),
          }],
          isError: true,
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
