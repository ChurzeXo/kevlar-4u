/**
 * MCP Sampling Execution Mode
 * 
 * Spawns independent sampling/createMessage calls for each persona,
 * achieving true parallel multi-agent execution.
 */

import type { ExecutionContext, ExecutionHandler, ExecutionResult, ExecutionMode, SamplingFunction } from "../base.js";
import type { Persona } from "../../utils/parser.js";
import { isSamplingSupported } from "../client.js";
import { readConfig } from "../config.js";
import { RateLimiter, withRetry } from "../limiter.js";
import { ResultAggregator, checkBudget, generateAggregatedReport } from "../aggregator.js";
import { logger } from "../../utils/logger.js";

export const MODE: ExecutionMode = "mcp_sampling";

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
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Sampling call failed", {
      event: "sampling_error",
      error: errorMsg,
    });
    throw err;
  }
}

// ── Sampling Handler ──────────────────────────────────────────────────────────

export const samplingHandler: ExecutionHandler = {
  mode: MODE,
  priority: 10, // Highest priority

  canExecute(): boolean {
    // Check if sampling is supported by client
    return isSamplingSupported();
  },

  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { personas, content, context: contextNote } = ctx;
    const config = readConfig();
    
    // Validate sampling function is provided
    if (!ctx.samplingFn) {
      throw new Error(
        "MCP Sampling 模式需要 samplingFn。请确保 MCP 客户端支持 sampling 能力。"
      );
    }
    
    const samplingFn = ctx.samplingFn;
    
    // Budget check
    checkBudget(personas.length, content.length);

    const limiter = new RateLimiter({
      maxConcurrent: config.multiAgent.maxConcurrency,
      minDelayMs: 1000,
    });

    const aggregator = new ResultAggregator();

    // Parallel execution with rate limiting and startup stagger (jitter)
    const promises = personas.map(async (persona, index) => {
      await limiter.acquire();
      
      try {
        // Add a small stagger delay (e.g. 50ms per persona index) to stagger parallel request initiation
        if (index > 0) {
          const jitterMs = index * 50 + Math.floor(Math.random() * 30);
          await new Promise((resolve) => setTimeout(resolve, jitterMs));
        }

        await limiter.waitForDelay();
        
        const result = await withRetry(
          () => executePersonaReview(samplingFn, persona, content, contextNote),
          {
            maxRetries: 3,
            onRetry: (attempt, error, delay) => {
              logger.warn("Sampling retry", {
                event: "sampling_retry",
                personaId: persona.meta.id,
                attempt,
                delayMs: delay,
                error: error.message,
              });
            },
          }
        );

        aggregator.addSuccess({
          personaId: persona.meta.id,
          personaName: persona.meta.name,
          review: result,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error("Persona review failed", {
          event: "persona_failed",
          personaId: persona.meta.id,
          error: errorMsg,
        });

        aggregator.addFailure(persona.meta.id, persona.meta.name, errorMsg);
      } finally {
        limiter.release();
      }
    });

    await Promise.all(promises);

    const results = aggregator.getResults();
    const failed = aggregator.getFailed();
    const successful = aggregator.getSuccessful();

    // Generate report
    const contentSummary = summarizeContent(content);
    
    const report = generateAggregatedReport({
      mode: MODE,
      contentSummary,
      personas: results,
      partialFailures: failed.map((f) => ({
        personaId: f.personaId,
        error: f.error || "Unknown error",
      })),
    });

    return {
      report,
      personas: successful.map((p) => p.personaId),
      mode: MODE,
      partialFailures: failed.map((f) => ({
        personaId: f.personaId,
        error: f.error || "Unknown error",
      })),
    };
  },
};

// ── Persona Review ────────────────────────────────────────────────────────────

async function executePersonaReview(
  samplingFn: SamplingFunction,
  persona: Persona,
  content: string,
  contextNote?: string
): Promise<string> {
  const userMessage = buildUserMessage(content, contextNote);
  
  const response = await callSamplingApi(
    samplingFn,
    persona.systemPrompt,
    userMessage
  );

  return response.content;
}

function buildUserMessage(content: string, contextNote?: string): string {
  let message = `请对以下内容进行评论：\n\n${content}`;
  if (contextNote) {
    message += `\n\n**发布平台 & 目标受众背景**：${contextNote}`;
  }
  return message;
}

// ── Content Summarizer ────────────────────────────────────────────────────────

function summarizeContent(content: string, maxLength = 50): string {
  if (content.length <= maxLength) return content;
  
  // Simple summarization: take first N chars
  return content.slice(0, maxLength) + "...";
}
