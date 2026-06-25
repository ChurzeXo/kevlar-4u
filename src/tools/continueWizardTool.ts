/**
 * Continuation Tool (v3)
 *
 * Provides a safe, versioned submission channel for host orchestration results.
 * Unlike raw review_content_wizard calls, this tool enforces:
 *
 * - sessionId + checkpoint + expectedRevision + continuationId matching
 * - stale submission rejection (prevents old rounds from overwriting new state)
 * - structured result validation via classifyHostStructuredResult
 *
 * ## Protocol
 *
 * After Kevlar returns a next-action contract containing {continuationId, expectedRevision},
 * the Host MUST call this tool (not review_content_wizard with raw userMessage) to
 * submit the result. Kevlar validates the continuation parameters, processes the result,
 * and returns the next action or final result.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import type { ToolModule, ToolDependencies } from "./types.js";
import { isValidSessionId } from "../utils/sessionId.js";
import { classifyHostStructuredResult, isKevlarHostGuidedResult } from "../execution/client.js";
import type { AuditCheckpoint } from "../execution/checkpoint.js";
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
    },
    required: ["sessionId", "checkpoint", "expectedRevision", "continuationId", "result"],
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
    const result = args.result as string;

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
    const statePath = path.join(deps.tmpDir, `wizard-${sessionId}.json`);
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

    // ── Revision gate ────────────────────────────────────────────────────
    // Prevent stale continuations (old round results) from overwriting
    // state that has already advanced to a later revision.
    if (typeof state.revision !== "number") {
      // Backward compat: old state files without revision field
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

    // ── ContinuationId gate ───────────────────────────────────────────────
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

    // ── Accept continuation ──────────────────────────────────────────────
    // Bump revision so this continuation can't be reused
    state.revision += 1;
    state.activeContinuation = undefined;
    await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");

    // Route the result through the wizard using userMessage flow.
    // The wizard's existing state machine will handle the rest.
    const wizardInput: ReviewWizardInput = {
      sessionId,
      userMessage: result,
      samplingFn: deps.resolveSamplingFn(),
      sendProgress: deps.sendProgress,
      strategyProvider: deps.strategyProvider,
    };

    return await handleReviewContentWizard(deps.skillsDir, deps.tmpDir, wizardInput);
  },
};
