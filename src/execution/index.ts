/**
 * Kevlar-4u Execution Engine
 * 
 * Unified entry point for all execution modes with automatic mode resolution.
 */

import { loadAllPersonas, loadPersonasByIds, Persona } from "../utils/parser.js";
import { logger } from "../utils/logger.js";
import { readConfig, isValidMode } from "./config.js";
import { isSamplingSupported, getClientFingerprint } from "./client.js";
import {
  getHostStructuredObservation,
  inferTaskClass,
} from "./observations.js";
import type { ClientFingerprint, HostOrchestrationStrategy } from "./plan.js";
import { orchestrationHandler } from "./modes/orchestration.js";
import { samplingHandler } from "./modes/sampling.js";
import { directApiHandler, hasApiKey } from "./modes/direct_api.js";
import { subagentHandler } from "./modes/subagent.js";
import { apiCircuitBreaker, CircuitBreakerOpenError } from "./limiter.js";
import { generateTraceId, generateSpanId, withTraceContext } from "../utils/observability.js";
import { toFrame, DEFAULT_SAMPLING_POLICY } from "./base.js";
import type {
  ExecutionContext,
  ExecutionHandler,
  ExecutionMode,
  ExecutionPlan,
  ExecutionResult,
  Frame,
  ModesInfo,
  ModeStatus,
  ResolveableMode,
  TraceContext,
} from "./base.js";

// ── Handler Registry ──────────────────────────────────────────────────────────

const handlers: ExecutionHandler[] = [
  orchestrationHandler, // priority: 30 (fallback)
  samplingHandler,      // priority: 10 (preferred)
  subagentHandler,      // priority: 15 (subagent dispatch)
  directApiHandler,     // priority: 20 (medium)
];

// ── Limits ────────────────────────────────────────────────────────────────────

export const MAX_PERSONAS = 50;

// ── Core Execution Function ───────────────────────────────────────────────────

export async function executeReview(
  mode: ResolveableMode,
  ctx: ExecutionContext
): Promise<ExecutionResult> {
  const resolved = mode === "auto" ? await resolveMode() : mode;
  const personaCount = ctx.personas.length;

  if (personaCount > MAX_PERSONAS) {
    throw new Error(`评审员数量超出限制（最多${MAX_PERSONAS}个，当前${personaCount}个）。`);
  }

  const handler = handlers.find((h) => h.mode === resolved);
  if (!handler) {
    throw new Error(`未知执行模式: ${resolved}`);
  }
  if (!handler.canExecute()) {
    throw new Error(`${resolved} 模式当前不可用`);
  }

  // Initialize trace context (MECP §8.3)
  const traceId = generateTraceId();
  const spanId = generateSpanId();
  const traceCtx: TraceContext = { traceId, spanId };
  const tracedCtx: ExecutionContext = { ...ctx, traceContext: traceCtx };

  logger.info("Executing review", withTraceContext({
    event: "review_execute",
    mode: resolved,
    personas: ctx.personas.length,
    contentLength: ctx.content.length,
  }, traceId, spanId));

  const startTime = Date.now();
  let result: ExecutionResult;

  if (resolved !== "orchestration") {
    // Circuit breaker check for direct_api mode
    if (resolved === "direct_api") {
      apiCircuitBreaker.check();
    }

    const { acquireReviewLock, releaseReviewLock, getReviewLock } = await import("./lock.js");
    
    if (!acquireReviewLock(resolved)) {
      const lock = getReviewLock();
      throw new Error(
        `已有评测任务正在执行（${lock?.mode || "unknown"}），请等待完成后再试。`
      );
    }

    try {
      result = await handler.execute(tracedCtx);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        logger.warn("Circuit breaker open, downgrading to orchestration", withTraceContext({
          event: "circuit_breaker_downgrade",
          originalMode: resolved,
        }, traceId, spanId));
        result = await orchestrationHandler.execute(tracedCtx);
      } else {
        throw err;
      }
    } finally {
      releaseReviewLock();
    }
  } else {
    result = await handler.execute(tracedCtx);
  }

  const durationMs = Date.now() - startTime;
  const failedCount = result.partialFailures?.length ?? 0;
  logger.info("Review summary", withTraceContext({
    event: "review_summary",
    mode: resolved,
    personas: ctx.personas.length,
    success: ctx.personas.length - failedCount,
    failure: failedCount,
    durationMs,
  }, traceId, spanId));

  // Attach MECP Frame envelope (§9.2)
  result.frame = toFrame(
    `kevlar/${resolved}`,
    "mcp/host",
    spanId,
    result.partialFailures?.length ? "response" : "response",
    { report: result.report, personas: result.personas, mode: result.mode, partialFailures: result.partialFailures },
    traceId,
  );

  return result;
}

// ── Mode Resolution ──────────────────────────────────────────────────────────

async function resolveMode(): Promise<ExecutionMode> {
  // Helper to check if a mode can execute
  const canExec = (modeName: ExecutionMode) => {
    const h = handlers.find(h => h.mode === modeName);
    return h ? h.canExecute() : false;
  };

  // 1. Check persisted config (user preference, highest priority)
  const config = readConfig();
  if (config.mode && config.mode !== "auto") {
    if (!isValidMode(config.mode)) {
      logger.warn("Invalid persisted mode, falling back to auto", {
        event: "mode_invalid_config",
        mode: config.mode,
      });
    } else {
      if (!canExec(config.mode)) {
        logger.warn(`Persisted mode ${config.mode} cannot execute in current environment. Will be silently downgraded.`, { event: "mode_silent_downgrade", mode: config.mode });
      }
      logger.debug("Using persisted mode", { event: "mode_persist", mode: config.mode });
      return config.mode;
    }
  }

  // 2. Check KEVLAR_MODE env var (global default, overridden by config)
  const envMode = process.env.KEVLAR_MODE as ResolveableMode | undefined;
  if (envMode && envMode !== "auto" && isValidMode(envMode)) {
    if (!canExec(envMode)) {
      logger.warn(`Env var mode ${envMode} cannot execute in current environment. Will be silently downgraded.`, { event: "mode_silent_downgrade", mode: envMode });
    }
    logger.debug("Using env var mode", { event: "mode_env", mode: envMode });
    return envMode;
  }

  // 3. Select first available by priority
  const sorted = [...handlers].sort((a, b) => a.priority - b.priority);
  for (const h of sorted) {
    if (h.canExecute()) {
      logger.debug("Auto-resolved mode", { event: "mode_auto", mode: h.mode });
      return h.mode;
    }
  }

  // 4. Fallback to orchestration (always available)
  return "orchestration";
}

// ── Execution Plan Resolution (v3) ────────────────────────────────────────────

/**
 * Resolve the ExecutionPlan for the current environment.
 *
 * Unlike {@link resolveMode} (which returns the legacy flat ExecutionMode
 * string), this returns an {@link ExecutionPlan} that separates the execution
 * backend from the host orchestration strategy.
 *
 * Priority (auto mode):
 *   1. direct_api        — Kevlar has its own API keys, fully controlled
 *   2. mcp_sampling      — Host declared sampling via MCP capabilities
 *   3. host_orchestration + structured — optimistic first attempt
 *   4. host_orchestration + standard   — fallback after structured fails
 *
 * Explicit mode via KEVLAR_MODE env or persisted config overrides auto.
 * Legacy values "mcp_subagent" and "host_guided_dispatch" are migrated to
 * `{ backend: "host_orchestration", strategy: "structured" }`.
 */
export function resolveExecutionPlan(
  options?: { fingerprint?: ClientFingerprint; content?: string },
): { plan: ExecutionPlan; legacyMode: ExecutionMode } {
  // 1. Check persisted config (user preference, highest priority)
  const config = readConfig();
  if (config.mode && config.mode !== "auto" && isValidMode(config.mode)) {
    const mode = config.mode as ExecutionMode;
    return { plan: legacyModeToPlan(mode), legacyMode: mode };
  }

  // 2. Check KEVLAR_MODE env var
  const envMode = process.env.KEVLAR_MODE as ResolveableMode | undefined;
  if (envMode && envMode !== "auto" && isValidMode(envMode)) {
    const mode = envMode as ExecutionMode;
    return { plan: legacyModeToPlan(mode), legacyMode: mode };
  }

  // 3. Auto-resolve: direct_api > mcp_sampling > host_orchestration
  if (hasApiKey()) {
    return { plan: { backend: "direct_api" }, legacyMode: "direct_api" };
  }

  if (isSamplingSupported()) {
    return {
      plan: { backend: "mcp_sampling", policy: DEFAULT_SAMPLING_POLICY },
      legacyMode: "mcp_sampling",
    };
  }

  // 4. No Direct API / Sampling available → Host Orchestration
  // Check observation cache: if we've previously observed this Host fail
  // at structured collaboration for this task class, start with standard.
  const fingerprint = options?.fingerprint ?? getClientFingerprint();
  const taskClass = inferTaskClass(options?.content);
  const cachedObs = getHostStructuredObservation({
    fingerprint,
    protocolVersion: "kevlar-host-guided/v1",
    taskClass,
  });

  const strategy: HostOrchestrationStrategy =
    cachedObs && (cachedObs.status === "unsupported" || cachedObs.status === "failed")
      ? "standard"
      : "structured";

  const lighterTaskMatch = cachedObs?.isLighter === true;

  logger.debug("Host orchestration strategy resolved", {
    event: "host_orchestration_strategy",
    strategy,
    cachedStatus: cachedObs?.status ?? "none",
    taskClass,
    lighterTaskMatch,
  });

  return {
    plan: { backend: "host_orchestration", strategy, lighterTaskMatch: lighterTaskMatch || undefined },
    legacyMode: strategy === "structured"
      ? ("mcp_subagent" as ExecutionMode)
      : "orchestration",
  };
}

/**
 * Map legacy flat ExecutionMode strings to the new ExecutionPlan type.
 *
 * - direct_api / mcp_sampling / orchestration → self-explanatory
 * - mcp_subagent → { host_orchestration, strategy: "structured" }
 *   (mcp_subagent was never a real backend; it was always host-guided)
 */
function legacyModeToPlan(mode: ExecutionMode): ExecutionPlan {
  switch (mode) {
    case "direct_api":
      return { backend: "direct_api" };
    case "mcp_sampling":
      return { backend: "mcp_sampling", policy: DEFAULT_SAMPLING_POLICY };
    case "orchestration":
      return { backend: "host_orchestration", strategy: "standard" };
    case "mcp_subagent":
      // Legacy: mcp_subagent was never an independent backend.
      // It was always host-guided structured collaboration.
      return { backend: "host_orchestration", strategy: "structured" };
  }
}

// ── Mode Information ──────────────────────────────────────────────────────────

export function getModesInfo(): ModesInfo {
  const config = readConfig();
  const currentMode = (config.mode || "auto") as ResolveableMode;

  const modes: ModeStatus[] = handlers.map((h) => ({
    mode: h.mode,
    available: h.canExecute(),
    reason: h.canExecute() ? undefined : (h.getReason ? h.getReason() : "当前环境不支持"),
  }));

  // Determine recommended mode
  const sorted = [...handlers].sort((a, b) => a.priority - b.priority);
  let recommended: ExecutionMode = "orchestration";
  for (const h of sorted) {
    if (h.canExecute()) {
      recommended = h.mode;
      break;
    }
  }

  // Check if resolved mode is available
  let resolved: ExecutionMode;
  if (currentMode === "auto") {
    resolved = recommended;
  } else {
    const handler = handlers.find((h) => h.mode === currentMode);
    resolved = handler?.canExecute() ? currentMode : recommended;
  }

  return {
    modes,
    recommendedMode: recommended,
    currentMode,
    resolvedMode: resolved,
  };
}

// ── Helper: Load Personas with Validation ───────────────────────────────────

export interface PersonaLoadingResult {
  personas: Persona[];
  missingIds?: string[];
}

export function validatePersonaFields(persona: Persona): void {
  // System auditors use a different schema - skip user-persona field validation
  if (persona.meta.tags.includes("system_auditor")) return;

  const prompt = persona.systemPrompt || "";
  const tags = persona.meta.tags ?? [];

  // Use structured metadata first, fall back to keyword matching in system prompt
  const hasPlatform = tags.length > 0 || prompt.includes("常用平台") || (persona.meta.description?.includes("平台") ?? false);
  const hasTraits = (persona.meta.description?.length ?? 0) >= 4 || prompt.includes("性格特质") || prompt.includes("性格");
  const hasBlindSpot = !!persona.meta.blindSpot || prompt.includes("盲区");

  if (!hasPlatform || !hasTraits || !hasBlindSpot) {
    throw new Error(`[${persona.meta.name}] 角色 ${!hasPlatform ? "缺少平台标签/描述, " : ""}${!hasTraits ? "缺少性格描述, " : ""}${!hasBlindSpot ? "缺少盲区" : ""}`);
  }
}

export async function loadPersonasForReview(
  skillsDir: string,
  personaIds?: string[]
): Promise<PersonaLoadingResult> {
  if (personaIds && personaIds.length > 0) {
    const personas = await loadPersonasByIds(skillsDir, personaIds);
    for (const p of personas) {
      validatePersonaFields(p);
    }
    const foundIds = new Set(personas.map((p) => p.meta.id));
    const missing = personaIds.filter((id) => !foundIds.has(id));
    return { personas, missingIds: missing.length > 0 ? missing : undefined };
  }
  const personas = await loadAllPersonas(skillsDir);
  for (const p of personas) {
    validatePersonaFields(p);
  }
  return { personas };
}

// ── Sampling Support Check ────────────────────────────────────────────────────

export { isSamplingSupported };

// ── Re-exports (v3) ───────────────────────────────────────────────────────────

export { getClientFingerprint } from "./client.js";
export { hasApiKey } from "./modes/direct_api.js";
export type { AuditCheckpoint, ExecutionTransition } from "./checkpoint.js";
export type {
  ExecutionPlan,
  ExecutionBackend,
  HostOrchestrationStrategy,
  HostStructuredCapabilityStatus,
  DispatchFailureReason,
  PreAuditContext,
  ClientFingerprint,
  TaskClass,
  StructuredObservationKey,
  HostStructuredObservation,
  SamplingExecutionPolicy,
} from "./plan.js";
