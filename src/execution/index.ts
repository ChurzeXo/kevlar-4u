/**
 * Kevlar Execution Engine
 * 
 * Unified entry point for all execution modes with automatic mode resolution.
 */

import { loadAllPersonas, loadPersonasByIds, Persona } from "../utils/parser.js";
import { logger } from "../utils/logger.js";
import { readConfig } from "./config.js";
import { isSamplingSupported } from "./client.js";
import { orchestrationHandler } from "./modes/orchestration.js";
import { samplingHandler } from "./modes/sampling.js";
import { directApiHandler } from "./modes/direct_api.js";
import type {
  ExecutionContext,
  ExecutionHandler,
  ExecutionMode,
  ExecutionResult,
  ModesInfo,
  ModeStatus,
  ResolveableMode,
} from "./base.js";

// ── Handler Registry ──────────────────────────────────────────────────────────

const handlers: ExecutionHandler[] = [
  orchestrationHandler, // priority: 30 (fallback)
  samplingHandler,      // priority: 10 (preferred)
  directApiHandler,     // priority: 20 (medium)
];

// ── Core Execution Function ───────────────────────────────────────────────────

export async function executeReview(
  mode: ResolveableMode,
  ctx: ExecutionContext
): Promise<ExecutionResult> {
  const resolved = mode === "auto" ? await resolveMode() : mode;

  const handler = handlers.find((h) => h.mode === resolved);
  if (!handler) {
    throw new Error(`未知执行模式: ${resolved}`);
  }
  if (!handler.canExecute()) {
    throw new Error(`${resolved} 模式当前不可用`);
  }

  logger.info("Executing review", {
    event: "review_execute",
    mode: resolved,
    personas: ctx.personas.length,
    contentLength: ctx.content.length,
  });

  // Acquire lock for non-orchestration modes (they make external calls)
  if (resolved !== "orchestration") {
    const { acquireReviewLock, releaseReviewLock, getReviewLock } = await import("./lock.js");
    
    if (!acquireReviewLock(resolved)) {
      const lock = getReviewLock();
      throw new Error(
        `已有 ${lock?.mode || "unknown"} 模式正在执行，请等待完成后再试。`
      );
    }

    try {
      return await handler.execute(ctx);
    } finally {
      releaseReviewLock();
    }
  }

  // Orchestration mode doesn't need locking
  return handler.execute(ctx);
}

// ── Mode Resolution ──────────────────────────────────────────────────────────

async function resolveMode(): Promise<ExecutionMode> {
  // 1. Check persisted config
  const config = readConfig();
  if (config.mode && config.mode !== "auto") {
    logger.debug("Using persisted mode", { event: "mode_persist", mode: config.mode });
    return config.mode;
  }

  // 2. Select first available by priority
  const sorted = [...handlers].sort((a, b) => a.priority - b.priority);
  for (const h of sorted) {
    if (h.canExecute()) {
      logger.debug("Auto-resolved mode", { event: "mode_auto", mode: h.mode });
      return h.mode;
    }
  }

  // 3. Fallback to orchestration (always available)
  return "orchestration";
}

// ── Mode Information ──────────────────────────────────────────────────────────

export function getModesInfo(): ModesInfo {
  const config = readConfig();
  const currentMode = (config.mode || "auto") as ResolveableMode;

  const modes: ModeStatus[] = handlers.map((h) => ({
    mode: h.mode,
    available: h.canExecute(),
    reason: h.canExecute() ? undefined : "当前环境不支持",
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

  const resolved = currentMode === "auto" ? recommended : currentMode;

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

export async function loadPersonasForReview(
  skillsDir: string,
  personaIds?: string[]
): Promise<PersonaLoadingResult> {
  if (personaIds && personaIds.length > 0) {
    const personas = await loadPersonasByIds(skillsDir, personaIds);
    const foundIds = new Set(personas.map((p) => p.meta.id));
    const missing = personaIds.filter((id) => !foundIds.has(id));
    return { personas, missingIds: missing.length > 0 ? missing : undefined };
  }
  const personas = await loadAllPersonas(skillsDir);
  return { personas };
}

// ── Sampling Support Check ────────────────────────────────────────────────────

export { isSamplingSupported };
