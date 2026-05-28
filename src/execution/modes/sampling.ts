/**
 * MCP Sampling Execution Mode
 * 
 * Spawns independent sampling/createMessage calls for each persona,
 * achieving true parallel multi-agent execution.
 */

import type { ExecutionContext, ExecutionHandler, ExecutionResult, ExecutionMode, SamplingFunction } from "../base.js";
import type { Persona } from "../../utils/parser.js";
import { isSamplingSupported } from "../client.js";
import { DEFAULT_DIMENSIONS_CONFIG } from "../dimensions.js";
import { executePersonasInParallel, buildUserMessage, augmentSystemPrompt } from "../parallel.js";
import { logger, getErrorInfo } from "../../utils/observability.js";

const MODE: ExecutionMode = "mcp_sampling";

// ── Sampling API Call ──────────────────────────────────────────────────────

async function callSamplingApi(
  samplingFn: SamplingFunction,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 4096
): Promise<{ content: string; stopReason?: string }> {
  logger.debug("Sampling call initiated", {
    event: "sampling_call",
    systemPromptLength: systemPrompt.length,
    userMessageLength: userMessage.length,
  });

  try {
    const result = await samplingFn({
      systemPrompt,
      message: userMessage,
      maxTokens,
    });

    logger.debug("Sampling call succeeded", {
      event: "sampling_success",
      contentLength: result.content.length,
    });

    return result;
  } catch (err) {
    const info = getErrorInfo(err);
    logger.error("Sampling call failed", {
      event: "sampling_error",
      error: info.code,
      message: info.message,
      recoverable: info.recoverable,
    });
    throw err;
  }
}

// ── Sampling Handler ──────────────────────────────────────────────────────────

export const samplingHandler: ExecutionHandler = {
  mode: MODE,
  priority: 10, // Highest priority

  canExecute(): boolean {
    return isSamplingSupported();
  },

  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { personas, content, context: contextNote } = ctx;
    const dimsConfig = ctx.dimensions ?? DEFAULT_DIMENSIONS_CONFIG;

    if (!ctx.samplingFn) {
      throw new Error(
        "MCP Sampling 模式需要 samplingFn。请确保 MCP 客户端支持 sampling 能力。"
      );
    }

    const samplingFn = ctx.samplingFn;

    return executePersonasInParallel(
      personas,
      content,
      { mode: MODE, retryEventName: "sampling", dimensions: dimsConfig, preAuditReport: ctx.preAuditReport },
      (persona: Persona) => {
        const response = executePersonaReview(samplingFn, persona, content, contextNote, dimsConfig, ctx.preAuditReport);
        return response;
      }
    );
  },
};

// ── Persona Review ────────────────────────────────────────────────────────────

async function executePersonaReview(
  samplingFn: SamplingFunction,
  persona: Persona,
  content: string,
  contextNote: string | undefined,
  dimensions?: import("../dimensions.js").DimensionsConfig,
  preAuditReport?: any
): Promise<string> {
  const userMessage = buildUserMessage(content, contextNote, dimensions, preAuditReport);

  const response = await callSamplingApi(
    samplingFn,
    augmentSystemPrompt(persona, dimensions, preAuditReport),
    userMessage
  );

  return response.content;
}
