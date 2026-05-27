/**
 * Parallel execution utilities for multi-agent modes
 *
 * Extracts the common parallel persona execution pattern shared
 * between mcp_sampling and direct_api modes.
 */

import type { Persona } from "../utils/parser.js";
import type { ExecutionMode, ExecutionResult, ExecutionContext } from "./base.js";
import type { DimensionsConfig } from "./dimensions.js";
import { DEFAULT_DIMENSIONS_CONFIG, buildDefensiveSystemDirective, buildOffensiveSystemDirective, buildPersonaContextDirective } from "./dimensions.js";
import { readConfig } from "./config.js";
import { getRateLimiter, withRetry } from "./limiter.js";
import { ResultAggregator, checkBudget, generateAggregatedReport } from "./aggregator.js";
import { logger } from "../utils/logger.js";
import { getErrorInfo } from "../utils/observability.js";
import { wrapContent } from "../utils/sanitize.js";

interface ParallelExecutionOptions {
  mode: ExecutionMode;
  retryEventName: string;
  dimensions?: DimensionsConfig;
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
      const info = getErrorInfo(err);
      logger.error("Persona review failed", {
        event: "persona_failed",
        personaId: persona.meta.id,
        error: info.code,
        message: info.message,
        recoverable: info.recoverable,
      });

      aggregator.addFailure(persona.meta.id, persona.meta.name, info.message);
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
    dimensions: options.dimensions ?? DEFAULT_DIMENSIONS_CONFIG,
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

/**
 * Build the complete augmented system prompt for a reviewer.
 * Order: persona identity → persona context → dimensions (defensive + offensive) → tone constraint
 */
export function augmentSystemPrompt(
  persona: Persona,
  dimensions?: DimensionsConfig,
): string {
  const dimsConfig = dimensions ?? DEFAULT_DIMENSIONS_CONFIG;
  const parts: string[] = [];

  // ① Persona identity (original system prompt)
  parts.push(persona.systemPrompt);

  // ② Persona context (structured metadata: age, gender, interests, etc.)
  const contextDirective = buildPersonaContextDirective(persona.meta);
  if (contextDirective.trim().length > "## 👤 评审员画像\n\n以下是你作为评审员的身份属性，请严格以此身份进行评审：\n".length) {
    parts.push(contextDirective);
  }

  // ③ Dimensions (defensive + offensive)
  parts.push(buildDefensiveSystemDirective());
  const offensiveDirective = buildOffensiveSystemDirective(dimsConfig);
  if (offensiveDirective) {
    parts.push(offensiveDirective);
  }

  // ④ Tone constraint (last — constrains output style)
  if (persona.meta.tone) {
    const toneList = Array.isArray(persona.meta.tone) ? persona.meta.tone.join("、") : persona.meta.tone;
    if (toneList) {
      parts.push(`## 🎙️ 讲话语气\n\n请以「${toneList}」的语气进行评审输出。`);
    }
  }

  return parts.join("\n\n---\n\n");
}

/**
 * @deprecated Use augmentSystemPrompt() instead. This function only injects
 * the defensive directive and ignores persona context + offensive dimensions + tone.
 */
export function augmentSystemPromptWithDefensive(systemPrompt: string): string {
	const defensiveDirective = buildDefensiveSystemDirective();
	return `${systemPrompt}\n\n---\n\n${defensiveDirective}`;
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
