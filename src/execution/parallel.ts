/**
 * Parallel execution utilities for multi-agent modes
 *
 * Extracts the common parallel persona execution pattern shared
 * between mcp_sampling and direct_api modes.
 */

import type { Persona } from "../utils/parser.js";
import type { ExecutionMode, ExecutionResult, ExecutionContext } from "./base.js";
import type { DimensionsConfig } from "./dimensions.js";
import { DEFAULT_DIMENSIONS_CONFIG, buildDefensiveSystemDirective, buildOffensiveSystemDirective, buildPersonaContextDirective, buildToneDirective, buildReviewUserMessage } from "./dimensions.js";
import { transformFindingsToFocusTopics, formatFocusTopicsForPrompt } from "./focusTopicTransform.js";
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
  preAuditReport?: any;
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
    preAuditReport: options.preAuditReport,
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
 * Order: persona identity → persona context → RST section → Focus Topics → dimensions (offensive) → tone constraint
 */
export function augmentSystemPrompt(
  persona: Persona,
  dimensions?: DimensionsConfig,
  preAuditReport?: any,
): string {
  // System auditors use their original specialized prompt as-is
  if (persona.meta.tags.includes("system_auditor")) {
    return persona.systemPrompt;
  }

  const dimsConfig = dimensions ?? DEFAULT_DIMENSIONS_CONFIG;
  const parts: string[] = [];

  // ① Persona identity (original system prompt)
  parts.push(persona.systemPrompt);

  // ② Persona context (structured metadata: age, gender, interests, etc.)
  const contextDirective = buildPersonaContextDirective(persona.meta);
  if (contextDirective.trim().length > "## 👤 评审员画像\n\n以下是你作为评审员的身份属性，请严格以此身份进行评审：\n".length) {
    parts.push(contextDirective);
  }

  // ③ RST section — archetype description (if RST configured)
  if (persona.meta.rst) {
    const rstSection = buildRSTSection(persona.meta.rst);
    if (rstSection) parts.push(rstSection);
  }

  // ④ Focus Topics — filtered + translated pre-audit findings (if available and RST configured)
  if (preAuditReport && persona.meta.rst) {
    const focusTopics = transformFindingsToFocusTopics(preAuditReport, persona.meta.rst);
    if (focusTopics.length > 0) {
      parts.push(formatFocusTopicsForPrompt(focusTopics));
    }
  }

  // ⑤ Offensive dimensions only (defensive dimensions are handled by system auditors in pre-audit)
  const offensiveDirective = buildOffensiveSystemDirective(dimsConfig);
  if (offensiveDirective) {
    parts.push(offensiveDirective);
  }

  // ⑥ Tone constraint (last — constrains output style)
  if (persona.meta.tone) {
    const toneDirective = buildToneDirective(persona.meta.tone);
    if (toneDirective) {
      parts.push(toneDirective);
    }
  }

  return parts.join("\n\n---\n\n");
}

/**
 * Build a descriptive RST section for the persona's system prompt.
 * Summarizes the four-layer人格 configuration in natural language.
 */
function buildRSTSection(rst: import("./dimensions.js").RSTConfig): string {
  const { RST_ARCHETYPES, RST_TRIGGERS, RST_REGIONAL_PACKS, RST_PLATFORM_CULTURES } = require("./dimensions.js");

  const archetypeLabels = rst.archetypes
    .map(id => RST_ARCHETYPES[id]?.label || id)
    .join(" + ");

  const triggerLabels = rst.triggers
    .map(id => RST_TRIGGERS[id]?.label || id)
    .join("、");

  const regionLabel = RST_REGIONAL_PACKS[rst.regionalPack]?.label || rst.regionalPack;
  const platformLabel = RST_PLATFORM_CULTURES[rst.platformCulture]?.label || rst.platformCulture;

  const lines = [
    "## 🧬 互联网反应模拟人格（RST）",
    "",
    `你的人格底色是「${archetypeLabels}」。`,
    "",
    `你对以下内容特征特别敏感：${triggerLabels || "无特殊触发器"}。`,
    "",
    `你所处的文化语境是「${regionLabel}」，活跃平台是「${platformLabel}」。`,
    "",
    "请以这个身份的真实反应模式来评论内容，而不是以评审员的分析视角。",
    "你的输出应该像一个真实互联网用户的第一反应，而不是一份评估报告。",
  ];

  return lines.join("\n");
}

/**
 * @deprecated Use augmentSystemPrompt() instead. This function only injects
 * the defensive directive and ignores persona context + offensive dimensions + tone.
 */
export function augmentSystemPromptWithDefensive(systemPrompt: string): string {
	const defensiveDirective = buildDefensiveSystemDirective();
	return `${systemPrompt}\n\n---\n\n${defensiveDirective}`;
}

export function buildUserMessage(content: string, contextNote: string | undefined, dimensions?: DimensionsConfig, preAuditReport?: any): string {
  const dimsConfig = dimensions ?? DEFAULT_DIMENSIONS_CONFIG;
  const wrapped = wrapContent(content);
  return buildReviewUserMessage(wrapped, contextNote, dimsConfig, preAuditReport);
}

function summarizeContent(content: string, maxLength = 50): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + "...";
}
