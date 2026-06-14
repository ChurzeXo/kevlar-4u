/**
 * Lightweight observability utilities for local-first tools.
 *
 * Designed for MCP servers and CLI tools that don't need OTel.
 * Provides structured error info, duration tracking, trace IDs,
 * and logger re-export.
 *
 * ── Usage ─────────────────────────────────────────────────────────────
 *
 *   import { logger, getErrorInfo, withDuration, generateTraceId, generateSpanId } from "./observability.js";
 *
 *   // 1. Structured logging
 *   logger.info("Review started", { event: "review_start", mode: "direct_api", personas: 5 });
 *   logger.warn("Rate limit approaching", { event: "rate_limit_warning" });
 *   logger.error("Execution failed", { event: "execute_error", error: "TIMEOUT" });
 *
 *   // 2. Extract structured error info (replaces ad-hoc instanceof checks)
 *   try { ... } catch (err) {
 *     const info = getErrorInfo(err);
 *     logger.error("Operation failed", { event: "op_failed", error: info.code, message: info.message, recoverable: info.recoverable });
 *     return { content: [{ type: "text", text: `❌ ${info.message}` }], isError: true };
 *   }
 *
 *   // 3. Measure duration
 *   const { result, durationMs } = await withDuration(() => someAsyncWork());
 *   logger.info("Work done", { event: "work_complete", durationMs });
 *
 *   // 4. Distributed tracing (MECP §8.3)
 *   const traceId = generateTraceId();
 *   const spanId = generateSpanId();
 *   logger.info("Trace started", { event: "trace_start", traceId, spanId });
 */

export { logger } from "./logger.js";
export type { LogContext } from "./logger.js";

// ── Structured Error Info ─────────────────────────────────────────────────────

export interface ErrorInfo {
  /** Error code for programmatic filtering (e.g. "VALIDATION_ERROR", "FILE_NOT_FOUND"). */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Whether the operation can be retried safely. */
  recoverable: boolean;
  /** Optional structured context attached by the error source. */
  details?: Record<string, unknown>;
}

/**
 * Extract structured error info from any thrown value.
 *
 * - If the error is a KevlarError (has .code + .recoverable), those fields are preserved.
 * - Otherwise, defaults to code="INTERNAL_ERROR", recoverable=false.
 *
 * Use this in every catch block instead of manual instanceof checks.
 */
export function getErrorInfo(err: unknown): ErrorInfo {
  if (isKevlarError(err)) {
    return {
      code: err.code,
      message: err.message,
      recoverable: err.recoverable,
      details: err.details,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: err instanceof Error ? err.message : String(err),
    recoverable: false,
  };
}

// ── Duration Wrapper ──────────────────────────────────────────────────────────

/**
 * Execute an async function and return its result alongside wall-clock duration.
 *
 *   const { result, durationMs } = await withDuration(() => api.call(params));
 *   logger.info("API call completed", { event: "api_done", durationMs });
 */
export async function withDuration<T>(
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, durationMs: Date.now() - start };
}

// ── Trace & Span ID Generation (MECP §8.3) ────────────────────────────────────

export function generateTraceId(): string {
  return `trace-${crypto.randomUUID()}`;
}

export function generateSpanId(): string {
  return `span-${crypto.randomUUID()}`;
}

/** Prefix a traceId and spanId onto a structured log context object. */
export function withTraceContext<T extends Record<string, unknown>>(ctx: T, traceId: string, spanId: string, parentSpanId?: string): T & { traceId: string; spanId: string; parentSpanId?: string } {
  return { ...ctx, traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}) } as T & { traceId: string; spanId: string; parentSpanId?: string };
}

// ── Internal (avoid circular dep with errors.ts) ──────────────────────────────

interface KevlarError extends Error {
  code: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

function isKevlarError(err: unknown): err is KevlarError {
  return err instanceof Error && "code" in err && "recoverable" in err;
}
