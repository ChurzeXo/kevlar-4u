/**
 * Parallel execution utilities for multi-agent modes
 *
 * Extracts the common parallel persona execution pattern used
 * by the orchestration execution pipeline.
 */

import type { Persona } from "../utils/parser.js";
import type { ExecutionMode, ExecutionResult, ExecutionContext } from "./base.js";
import type { DimensionsConfig } from "./dimensions.js";
import { DEFAULT_DIMENSIONS_CONFIG, buildDefensiveSystemDirective, buildOffensiveSystemDirective, buildPersonaContextDirective, buildToneDirective, buildReviewUserMessage, RST_ARCHETYPES, RST_TRIGGERS, RST_REGIONAL_PACKS, RST_PLATFORM_CULTURES } from "./dimensions.js";
import { transformFindingsToFocusTopics, formatFocusTopicsForPrompt } from "./focusTopicTransform.js";
import { readConfig } from "./config.js";
import { getRateLimiter, withRetry } from "./limiter.js";
import { ResultAggregator, checkBudget, generateAggregatedReport } from "./aggregator.js";
import { logger } from "../utils/logger.js";
import { getErrorInfo } from "../utils/observability.js";
import { wrapContent } from "../utils/sanitize.js";
import { buildKevlarRiskDirective } from "./riskPrompt.js";
import { buildCoreReasoningFramework, buildCoreFrameworkSteps, buildCompactAuditorCoT, buildCommonRiskRules } from "../prompts/reviewWizard.js";

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

  checkBudget(personas.length, content.length, personas.map(p => p.systemPrompt), options.mode);

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
      const mcpCode = (err as any)?.code;

      if (mcpCode === -1) {
        logger.warn("Sampling request rejected by user", {
          event: "sampling_rejected",
          personaId: persona.meta.id,
        });
        aggregator.addSkipped(persona.meta.id, persona.meta.name, "User rejected sampling request");
        return;
      }

      if (mcpCode === -32602) {
        logger.debug("Sampling tasks/cancel on already-terminal task (ignored)", {
          event: "sampling_cancel_terminal",
          personaId: persona.meta.id,
        });
        return;
      }

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

  const timeoutMs = config.multiAgent.timeoutMs * personas.length;

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Persona execution timed out after ${timeoutMs}ms (${personas.length} personas)`));
    }, timeoutMs);
  });

  await Promise.race([Promise.all(promises), timeoutPromise]);

  const results = aggregator.getResults();
  const failed = aggregator.getFailed();
  const successful = aggregator.getSuccessful();

  const report = generateAggregatedReport({
    mode: options.mode,
    contentSummary: summarizeContent(content),
    personas: results,
    dimensions: options.dimensions ?? DEFAULT_DIMENSIONS_CONFIG,
    preAuditReport: options.preAuditReport,
    skipped: aggregator.getSkipped(),
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
 * Order: core reasoning framework → risk rules → persona identity → persona context → 
 *        RST section → Focus Topics → dimensions (offensive) → tone constraint
 * 
 * Semantic baseline: orchestration mode prompt protocol (reviewWizard.ts)
 * Execution baseline: orchestration parallel pipeline
 */
export function augmentSystemPrompt(
  persona: Persona,
  dimensions?: DimensionsConfig,
  preAuditReport?: any,
): string {
  const dimsConfig = dimensions ?? DEFAULT_DIMENSIONS_CONFIG;
  const parts: string[] = [];

  // ① Core reasoning framework (职业黑粉/最恶毒评论区模拟模式) - semantic baseline
  parts.push(buildCoreReasoningFramework());

  // ①.5 Common risk rules (semantic baseline)
  parts.push(buildCommonRiskRules());

  // ② Persona identity (original system prompt)
  parts.push(persona.systemPrompt);

  // ③ Persona context (structured metadata: age, gender, interests, etc.)
  const contextDirective = buildPersonaContextDirective(persona.meta);
  if (contextDirective.trim().length > "## 👤 评审员画像\n\n以下是你作为评审员的身份属性，请严格以此身份进行评审：\n".length) {
    parts.push(contextDirective);
  }

  // ④ RST section — archetype description (if RST configured)
  if (persona.meta.rst) {
    const rstSection = buildRSTSection(persona.meta.rst);
    if (rstSection) parts.push(rstSection);
  }

  // ⑤ Focus Topics — filtered + translated pre-audit findings (if available and RST configured)
  if (preAuditReport && persona.meta.rst) {
    const focusTopics = transformFindingsToFocusTopics(preAuditReport, persona.meta.rst);
    if (focusTopics.length > 0) {
      parts.push(formatFocusTopicsForPrompt(focusTopics));
    }
  }

  // ⑥ Offensive dimensions only (defensive dimensions are handled by system auditors in pre-audit)
  const offensiveDirective = buildOffensiveSystemDirective(dimsConfig);
  if (offensiveDirective) {
    parts.push(offensiveDirective);
  }

  // ⑦ Dimension-specific reasoning method (if persona has RST config, inject core steps + compact CoT)
  if (persona.meta.rst) {
    const coreSteps = buildCoreFrameworkSteps();
    const compactCoT = buildCompactAuditorCoT(persona);
    if (compactCoT) {
      parts.push(`## 🧠 维度专项推理方法\n\n${coreSteps}\n\n${compactCoT}`);
    }
  }

  // ⑧ PRD red-team association method (includes common risk rules + sandbox isolation)
  parts.push(buildKevlarRiskDirective());

  // ⑨ Tone constraint (last — constrains output style)
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
export function buildRSTSection(rst: import("./dimensions.js").RSTConfig): string {

  const archetypeLabels = rst.archetypes
    .map(id => RST_ARCHETYPES[id]?.label || id)
    .join(" + ");

  const triggerLabels = rst.triggers
    .map(id => RST_TRIGGERS[id]?.label || id)
    .join("、");

  const regionLabel = RST_REGIONAL_PACKS[rst.regionalPack]?.label || rst.regionalPack;
  const platformLabel = rst.platformCulture ? RST_PLATFORM_CULTURES[rst.platformCulture]?.label : null;

  const lines = [
    "## 🧬 舆论仿真人格配置（RST）",
    "",
    `你的人格底色是「${archetypeLabels}」。`,
    "",
    `你对以下内容特征特别敏感：${triggerLabels || "无特殊触发器"}。`,
    "",
    `你所处的文化语境是「${regionLabel}」。`,
    platformLabel ? `你主要活跃在「${platformLabel}」平台上。` : "",
    "",
    "你的输出应该像一个真实互联网用户的第一反应，而不是一份评估报告。",
  ];

  return lines.filter(Boolean).join("\n");
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
