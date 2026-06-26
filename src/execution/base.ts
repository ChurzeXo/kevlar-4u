/**
 * Base types and interfaces for Kevlar-4u execution modes
 */

import type { Persona } from "../utils/parser.js";
import type { DimensionsConfig } from "./dimensions.js";

// ── Execution Plan Types (v3) ─────────────────────────────────────────────────
// Re-export the new ExecutionPlan type system from plan.ts.
// ExecutionMode is kept for backward compatibility — existing code in
// aggregator.ts, parallel.ts, config.ts, reviewContentWizardTool.ts, and
// all mode handlers still references it. Migration will be incremental.

export type {
  ExecutionBackend,
  ExecutionPlan,
  HostOrchestrationStrategy,
  SamplingStrategy,
  HostStructuredCapabilityStatus,
  DispatchFailureReason,
  PreAuditContext,
  ClientFingerprint,
  TaskClass,
  StructuredObservationKey,
  HostStructuredObservation,
} from "./plan.js";

export type ExecutionMode = "orchestration" | "mcp_subagent" | "mcp_sampling";

export type ResolveableMode = ExecutionMode | "auto";

// ── Budget Policy (MECP §8.2) ────────────────────────────────────────────────

export interface BudgetPolicy {
  maxAgentTokens: number;
  maxTurns: number;
  maxSessionTokens: number;
}

// ── Tracing (MECP §8.3) ──────────────────────────────────────────────────────

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

// ── Usage Tracking ───────────────────────────────────────────────────────────

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

// ── Sampling Function Type ───────────────────────────────────────────────────

export type SamplingFunction = (params: {
  systemPrompt: string;
  message: string;
  maxTokens?: number;
}) => Promise<{ content: string; stopReason?: string; usage?: UsageInfo }>;

export type MultiTurnSamplingFunction = (params: {
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
}) => Promise<{ content: string; stopReason?: string; usage?: UsageInfo }>;

// ── Review Run Context (frozen at run start) ──────────────────────────────────

export interface ReviewRunContext {
  reviewRunId: string;
  strategySessionId: string;
  strategyVersion: string;
  strategyHash: string;
  promptSetHash: string;
  weightSetHash: string;
  executionMode: ExecutionMode;
  locale: "zh-CN" | "en-US";
  startedAt: string;
}

// ── Execution Context ─────────────────────────────────────────────────────────

export interface ExecutionContext {
  skillsDir: string;
  personas: Persona[];
  content: string;
  context?: string;
  samplingFn?: SamplingFunction;
  dimensions?: DimensionsConfig;
  preAuditReport?: any;
  traceContext?: TraceContext;
  runContext?: ReviewRunContext;
  tier?: "free" | "pro";
  server?: any;
}

// ── MECP Frame (MECP §9.2) ────────────────────────────────────────────────────

/** Standardized actor-to-actor communication envelope. */
export interface Frame<T = unknown> {
  source: string;
  destination: string;
  correlationId: string;
  traceId?: string;
  type: "request" | "response" | "event" | "error";
  payload: T;
  timestamp: string;
}

/** Build a MECP-compliant Frame envelope. */
export function toFrame<T>(
  source: string,
  destination: string,
  correlationId: string,
  type: Frame["type"],
  payload: T,
  traceId?: string,
): Frame<T> {
  return {
    source,
    destination,
    correlationId,
    traceId,
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
}

// ── Execution Result ─────────────────────────────────────────────────────────

export interface ExecutionResult {
  report: string;
  personas: string[]; // participating persona IDs
  mode: ExecutionMode;
  partialFailures?: Array<{ personaId: string; error: string }>;
  /** MECP Frame envelope (§9.2). */
  frame?: Frame<unknown>;
}

// ── Execution Handler Interface ─────────────────────────────────────────────

export interface ExecutionHandler {
  mode: ExecutionMode;
  /** Check if current environment supports this mode */
  canExecute(): boolean;
  /** Get specific reason why it cannot be executed */
  getReason?: () => string;
  /** Execute the review */
  execute(ctx: ExecutionContext): Promise<ExecutionResult>;
  /** Default priority (lower number = higher priority) */
  priority: number;
}

// ── Mode Availability ─────────────────────────────────────────────────────────

export interface ModeStatus {
  mode: ExecutionMode;
  available: boolean;
  reason?: string;
}

export interface ModesInfo {
  modes: ModeStatus[];
  recommendedMode: ExecutionMode;
  currentMode: ResolveableMode;
  resolvedMode: ExecutionMode;
}
