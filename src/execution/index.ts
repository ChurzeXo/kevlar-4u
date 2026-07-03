/**
 * Kevlar-4u Execution Engine
 * 
 * Unified entry point for all execution modes with automatic mode resolution.
 */

import { loadAllPersonas, loadPersonasByIds, Persona } from "../utils/parser.js";
import { log } from "../utils/logCategories.js";
import { writeRawStderr } from "../utils/logger.js";
import { invalidInputError, validationError } from "../utils/errors.js";
import { readConfig, isValidMode } from "./config.js";
import { getClientFingerprint, getHostExecutionCapability, isTaskAugmentedSamplingSupported, isSamplingSupported } from "./client.js";
import {
  getHostStructuredObservation,
  inferTaskClass,
} from "./observations.js";
import type { ClientFingerprint, HostOrchestrationStrategy } from "./plan.js";
import { orchestrationHandler } from "./modes/orchestration.js";
import { executeSamplingReview } from "./samplingExecution.js";
import { generateTraceId, generateSpanId, withTraceContext } from "../utils/observability.js";
import { toFrame } from "./base.js";
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
    throw invalidInputError(`评审员数量超出限制（最多${MAX_PERSONAS}个，当前${personaCount}个）。`);
  }

  // Initialize trace context
  const traceId = generateTraceId();
  const spanId = generateSpanId();
  const traceCtx: TraceContext = { traceId, spanId };
  const tracedCtx: ExecutionContext = { ...ctx, traceContext: traceCtx };

  log.audit.info("Executing review", withTraceContext({
    event: "review_execute",
    mode: resolved,
    personas: ctx.personas.length,
    contentLength: ctx.content.length,
  }, traceId, spanId));

  const startTime = Date.now();
  let result: ExecutionResult;

  // ── Resolve execution plan for sampling backends ──────────────────────
  const planResult = resolveExecutionPlan({
    fingerprint: getClientFingerprint(),
    content: ctx.content,
  });
  const backend = planResult.plan.backend;

  if (backend === "sampling_task_augmented" || backend === "sampling_serial") {
    try {
      const samplingResults = await executeSamplingReview(
        ctx.server,
        ctx.personas,
        ctx.content,
        {
          localFindings: [],
          samplingFn: ctx.samplingFn as any,
        },
      );

      result = {
        report: JSON.stringify(samplingResults, null, 2),
        personas: ctx.personas.map((p) => p.meta.id),
        mode: "mcp_sampling",
        partialFailures: samplingResults
          .filter((r) => r.findings.length === 0)
          .map((r) => ({ personaId: r.id, error: "No findings" })),
      };
    } catch (err: any) {
      log.sampling.warn("Sampling execution failed, falling back to orchestration", {
        event: "sampling_fallback_to_orchestration",
        backend,
        error: (err as Error).message,
      });
      result = await orchestrationHandler.execute(tracedCtx);
    }
  } else {
    // Kevlar does not call LLMs or sampling function.
    // It always delegates to orchestrationHandler.
    result = await orchestrationHandler.execute(tracedCtx);
  }

  const durationMs = Date.now() - startTime;
  const failedCount = result.partialFailures?.length ?? 0;
  log.audit.info("Review summary", withTraceContext({
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
  const canExec = (modeName: ExecutionMode) => {
    const h = handlers.find(h => h.mode === modeName);
    return h ? h.canExecute() : false;
  };

  // 1. Check persisted config (user preference, highest priority)
  const config = readConfig();
  if (config.mode && config.mode !== "auto") {
    if (!isValidMode(config.mode)) {
      log.config.warn("Invalid persisted mode, falling back to auto", {
        event: "mode_invalid_config",
        mode: config.mode,
      });
    } else {
      if (!canExec(config.mode)) {
        log.config.warn(`Persisted mode ${config.mode} cannot execute in current environment. Will be silently downgraded.`, { event: "mode_silent_downgrade", mode: config.mode });
      }
      log.config.debug("Using persisted mode", { event: "mode_persist", mode: config.mode });
      return config.mode;
    }
  }

  // 2. Check KEVLAR_MODE env var (global default, overridden by config)
  const envMode = process.env.KEVLAR_MODE as ResolveableMode | undefined;
  if (envMode && envMode !== "auto" && isValidMode(envMode)) {
    if (!canExec(envMode)) {
      log.config.warn(`Env var mode ${envMode} cannot execute in current environment. Will be silently downgraded.`, { event: "mode_silent_downgrade", mode: envMode });
    }
    log.config.debug("Using env var mode", { event: "mode_env", mode: envMode });
    return envMode;
  }

  // 3. Fallback to orchestration (always available)
  return "orchestration";
}

// ── Execution Plan Resolution (v3) ────────────────────────────────────────────

/**
 * Resolve the ExecutionPlan for the current environment.
 */
export function resolveExecutionPlan(
  options?: { fingerprint?: ClientFingerprint; content?: string },
): { plan: ExecutionPlan; legacyMode: ExecutionMode } {
  const fingerprint = options?.fingerprint ?? getClientFingerprint();
  const taskClass = inferTaskClass(options?.content);
  let result: { plan: ExecutionPlan; legacyMode: ExecutionMode };
  let resolutionSource: string;

  // 1. Check persisted config (user preference, highest priority)
  const config = readConfig();
  if (config.mode && config.mode !== "auto" && isValidMode(config.mode)) {
    const mode = config.mode as ExecutionMode;
    result = { plan: legacyModeToPlan(mode), legacyMode: mode };
    resolutionSource = "persisted_config";
  }

  // 2. Check KEVLAR_MODE env var
  else if (process.env.KEVLAR_MODE && process.env.KEVLAR_MODE !== "auto" && isValidMode(process.env.KEVLAR_MODE as ResolveableMode)) {
    const mode = process.env.KEVLAR_MODE as ExecutionMode;
    result = { plan: legacyModeToPlan(mode), legacyMode: mode };
    resolutionSource = "env_var";
  }

  // 3. Auto-resolve: Capability-based degradation chain
  else {
    resolutionSource = "auto";

    // L1: Task-augmented sampling (true parallel)
    if (isTaskAugmentedSamplingSupported()) {
      result = {
        plan: { backend: "sampling_task_augmented" },
        legacyMode: "mcp_sampling",
      };
      log.config.debug("Auto-resolved to task-augmented sampling", {
        event: "sampling_task_augmented_detected",
        backend: "sampling_task_augmented",
      });
    }

    // L2: Serial MCP sampling
    else if (isSamplingSupported()) {
      result = {
        plan: { backend: "sampling_serial" },
        legacyMode: "mcp_sampling",
      };
      log.config.debug("Auto-resolved to serial MCP sampling", {
        event: "sampling_serial_detected",
        backend: "sampling_serial",
      });
    }

    // L3/L4: Host orchestration (always available)
    else {
      const hostExecCap = getHostExecutionCapability();

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

      log.config.debug("Host orchestration strategy resolved", {
        event: "host_orchestration_strategy",
        strategy,
        cachedStatus: cachedObs?.status ?? "none",
        taskClass,
        lighterTaskMatch,
      });

      result = {
        plan: { backend: "host_orchestration", strategy, lighterTaskMatch: lighterTaskMatch || undefined },
        legacyMode: strategy === "structured"
          ? ("mcp_subagent" as ExecutionMode)
          : "orchestration",
      };
    }
  }

  const resolvedMode = result.legacyMode;
  const requestedMode = config.mode && config.mode !== "auto"
    ? config.mode
    : process.env.KEVLAR_MODE ?? "auto";
  log.config.info("Mode resolved", {
    event: "mode_resolved",
    requested: requestedMode,
    resolved: resolvedMode,
    reason: resolutionSource,
    backend: result.plan.backend,
    strategy: "strategy" in result.plan ? result.plan.strategy : undefined,
    taskClass: result.plan.backend === "host_orchestration" ? taskClass : undefined,
    clientFingerprint: { name: fingerprint?.name, version: fingerprint?.version },
  });

  writeRawStderr(
    `[Kevlar-4u] 🎯 Backend: ${result.plan.backend}` +
    ("strategy" in result.plan && result.plan.strategy ? ` (${result.plan.strategy})` : "") +
    ` | client: sampling=${isSamplingSupported() ? "✅" : "❌"}` +
    ` taskAug=${isTaskAugmentedSamplingSupported() ? "✅" : "❌"}` +
    ` | source: ${resolutionSource}`,
  );

  return result;
}

/**
 * Map legacy flat ExecutionMode strings to the new ExecutionPlan type.
 */
function legacyModeToPlan(mode: ExecutionMode): ExecutionPlan {
  switch (mode) {
    case "orchestration":
      return { backend: "host_orchestration", strategy: "standard" };
    case "mcp_subagent":
      return { backend: "host_orchestration", strategy: "structured" };
    case "mcp_sampling":
      return { backend: "sampling_serial" };
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

  // Add subagent mode status manually since we decoupled direct execution but it's available via host-guided
  modes.push({
    mode: "mcp_subagent",
    available: true,
    reason: undefined,
  });

  // Add MCP sampling modes based on capability detection
  const hasTaskAug = isTaskAugmentedSamplingSupported();
  const hasSampling = isSamplingSupported();

  modes.push({
    mode: "mcp_sampling",
    available: hasTaskAug || hasSampling,
    reason: hasTaskAug
      ? "task-augmented 并行采样可用"
      : hasSampling
        ? "串行 MCP 采样可用"
        : "客户端未声明 sampling 能力",
  });

  // Determine recommended mode
  let recommended: ExecutionMode =
    hasTaskAug ? "mcp_sampling" :
    hasSampling ? "mcp_sampling" :
    "mcp_subagent";

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
  if (persona.meta.tags.includes("system_auditor")) return;

  const prompt = persona.systemPrompt || "";
  const tags = persona.meta.tags ?? [];

  const hasPlatform = tags.length > 0 || prompt.includes("常用平台") || (persona.meta.description?.includes("平台") ?? false);
  const hasTraits = (persona.meta.description?.length ?? 0) >= 4 || prompt.includes("性格特质") || prompt.includes("性格");
  const hasBlindSpot = !!persona.meta.blindSpot || prompt.includes("盲区");

  if (!hasPlatform || !hasTraits || !hasBlindSpot) {
    throw validationError(`[${persona.meta.name}] 角色 ${!hasPlatform ? "缺少平台标签/描述, " : ""}${!hasTraits ? "缺少性格描述, " : ""}${!hasBlindSpot ? "缺少盲区" : ""}`);
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

// ── Re-exports (v3) ───────────────────────────────────────────────────────────

export { getClientFingerprint } from "./client.js";
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
} from "./plan.js";

export {
  runAggregationValidation,
  validateContinuationGate,
  validateReceipt,
  fallbackToStandardOrchestration,
  MAX_CONTINUATION_RETRIES,
  type AgentBlueprint,
  type AgentDefinition,
  type AggregationSpec,
  type ContinuationSpec,
  type ExecutionReceipt,
  type AgentExecutionResult,
  type AggregationReport,
  type AggregationDimension,
  type AgentOutput,
  type Finding,
  type AggregationValidation,
  type ReceiptValidation,
} from "./protocol.js";
