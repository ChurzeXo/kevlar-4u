/**
 * Parallel execution utilities for multi-agent modes
 *
 * Extracts the common parallel persona execution pattern shared
 * between mcp_sampling and direct_api modes.
 */

import type { Persona } from "../utils/parser.js";
import type { ExecutionMode, ExecutionResult } from "./base.js";
import { readConfig } from "./config.js";
import { getRateLimiter, withRetry } from "./limiter.js";
import { ResultAggregator, checkBudget, generateAggregatedReport } from "./aggregator.js";
import { logger } from "../utils/logger.js";
import { wrapContent } from "../utils/sanitize.js";

interface ParallelExecutionOptions {
  mode: ExecutionMode;
  retryEventName: string;
}

export async function executePersonasInParallel(
  personas: Persona[],
  content: string,
  options: ParallelExecutionOptions,
  executor: (persona: Persona) => Promise<string>
): Promise<ExecutionResult> {
  const config = readConfig();

  checkBudget(personas.length, content.length, personas.map(p => p.systemPrompt));

  const limiter = getRateLimiter({
    maxConcurrent: config.multiAgent.maxConcurrency,
    minDelayMs: Number(process.env.KEVLAR_MIN_DELAY_MS) || 1000,
  });

  const aggregator = new ResultAggregator();

  const promises = personas.map(async (persona) => {
    await limiter.acquire();

    try {
      await limiter.waitForDelay();

      const result = await withRetry(
        () => executor(persona),
        {
          maxRetries: 3,
          onRetry: (attempt, error, delay) => {
            logger.warn(`${options.retryEventName} retry`, {
              event: `${options.retryEventName}_retry`,
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

  const report = generateAggregatedReport({
    mode: options.mode,
    contentSummary: summarizeContent(content),
    personas: results,
  });

  return {
    report,
    personas: successful.map((p) => p.personaId),
    mode: options.mode,
    partialFailures: failed.map((f) => ({
      personaId: f.personaId,
      error: f.error || "Unknown error",
    })),
  };
}

export function buildUserMessage(content: string, contextNote?: string): string {
  const wrapped = wrapContent(content);
  let message = `请对以下内容进行评论：\n\n${wrapped}`;
  if (contextNote) {
    message += `\n\n**发布平台 & 目标受众背景**：${contextNote}`;
  }
  return message;
}

function summarizeContent(content: string, maxLength = 50): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + "...";
}
