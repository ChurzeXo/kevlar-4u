/**
 * Kevlar Log Categories — Structured logging gateway.
 *
 * Provides:
 *   1. Category-based log filtering via KEVLAR_LOG_CATEGORIES env var
 *   2. Helper functions for common log patterns (handshake, audit, etc.)
 *   3. Event name constants (from logEvents.ts)
 *
 * Usage:
 *   import { log } from "../utils/logCategories.js";
 *   log.handshake("Client handshake complete", { clientName, hasSampling });
 *   log.audit("Review started", { mode, personaCount });
 *
 * Filtering:
 *   KEVLAR_LOG_CATEGORIES=handshake,audit   # Only show handshake + audit events
 *   KEVLAR_LOG_CATEGORIES=all               # Show all (default)
 *   KEVLAR_LOG_CATEGORIES=sampling          # Only sampling lifecycle
 */

import { logger } from "./logger.js";
import type { LogContext } from "./logger.js";

// Re-export all event name constants
export * from "./logEvents.js";

// ── Category Filter ──────────────────────────────────────────────────────────

type LogCategory = "handshake" | "audit" | "sampling" | "persona" | "wizard" | "config" | "pro" | "rules" | "tool" | "system";

const enabledCategories: Set<LogCategory> | null = (() => {
  const raw = process.env.KEVLAR_LOG_CATEGORIES?.trim();
  if (!raw || raw === "all") return null; // null = all enabled
  return new Set(raw.split(",").map(s => s.trim()) as LogCategory[]);
})();

function isCategoryEnabled(category: LogCategory): boolean {
  if (!enabledCategories) return true;
  return enabledCategories.has(category);
}

// ── Category Helpers ─────────────────────────────────────────────────────────

function createCategoryLogger(category: LogCategory) {
  return {
    info(message: string, context: LogContext & Record<string, unknown>) {
      if (!isCategoryEnabled(category)) return;
      logger.info(message, { ...context, _category: category });
    },
    warn(message: string, context: LogContext & Record<string, unknown>) {
      if (!isCategoryEnabled(category)) return;
      logger.warn(message, { ...context, _category: category });
    },
    error(message: string, context: LogContext & Record<string, unknown>) {
      if (!isCategoryEnabled(category)) return;
      logger.error(message, { ...context, _category: category });
    },
    debug(message: string, context: LogContext & Record<string, unknown>) {
      if (!isCategoryEnabled(category)) return;
      logger.debug(message, { ...context, _category: category });
    },
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export const log = {
  handshake: createCategoryLogger("handshake"),
  audit: createCategoryLogger("audit"),
  sampling: createCategoryLogger("sampling"),
  persona: createCategoryLogger("persona"),
  wizard: createCategoryLogger("wizard"),
  config: createCategoryLogger("config"),
  pro: createCategoryLogger("pro"),
  rules: createCategoryLogger("rules"),
  tool: createCategoryLogger("tool"),
  system: createCategoryLogger("system"),
};

// Re-export logger for direct use (backward compat)
export { logger };
