/**
 * Execution Plan Type System (v3 Revised)
 *
 * Splits the flat ExecutionMode concept into ExecutionBackend (who executes)
 * and HostOrchestrationStrategy (how the host collaborates).
 *
 * Also includes HostStructuredCapabilityStatus for tracking which hosts
 * have demonstrated the ability to return Kevlar-structured audit results.
 */

import type { Step0Result, Precedent } from "../prompts/reviewWizard.js";

// ── Execution Backend ──────────────────────────────────────────────────────────

/** Who actually performs the model calls during a review run. */
export type ExecutionBackend = "direct_api" | "mcp_sampling" | "host_orchestration";

/**
 * When backend is "host_orchestration", what collaboration protocol
 * does Kevlar request from the host AI?
 */
export type HostOrchestrationStrategy = "structured" | "standard";

/**
 * An ExecutionPlan describes how a single review run will be executed.
 *
 * Unlike the flat ExecutionMode string, it separates the question of
 * "who calls the model" (backend) from "how does Kevlar instruct them"
 * (strategy, only relevant for host_orchestration).
 */
export type ExecutionPlan =
  | { backend: "direct_api" }
  | { backend: "mcp_sampling"; policy?: SamplingExecutionPolicy }
  | { backend: "host_orchestration"; strategy: HostOrchestrationStrategy; lighterTaskMatch?: boolean };

// ── Sampling Execution Policy ─────────────────────────────────────────────────

/**
 * Controls how Kevlar fans out Sampling calls.
 *
 * Sampling ≠ Subagent Dispatch. Sampling is an MCP protocol capability
 * (createMessage), not a task-scheduling primitive. Some hosts serialize
 * concurrent sampling requests or limit in-flight count.
 */
export interface SamplingExecutionPolicy {
  /** Maximum concurrent reviewer calls. */
  maxConcurrency: number;
  /** Timeout for a single createMessage call. */
  timeoutMs: number;
  /** Number of allowed retries per reviewer on failure. */
  retryBudget: number;
  /** If concurrent execution fails, retry reviewers one-by-one. */
  fallbackToSequential: boolean;
}

export const DEFAULT_SAMPLING_POLICY: SamplingExecutionPolicy = {
  maxConcurrency: 2,
  timeoutMs: 30_000,
  retryBudget: 1,
  fallbackToSequential: true,
};

// ── Host Structured Capability Status ─────────────────────────────────────────

/**
 * What Kevlar currently knows about this Host's ability to participate
 * in the structured collaboration protocol.
 *
 * NOTE: "dispatch_verified" does NOT exist here. It can only be reached
 * when MCP protocol has a real task receipt API. Do not add it prematurely.
 */
export type HostStructuredCapabilityStatus =
  | "unknown"
  | "format_verified"
  | "unsupported"
  | "failed";

// ── Dispatch Failure Reasons ──────────────────────────────────────────────────

export type DispatchFailureReason =
  | "no_response"
  | "invalid_json"
  | "likely_output_truncated"
  | "schema_mismatch"
  | "host_rejected";

// ── Pre-Audit Context ─────────────────────────────────────────────────────────

/**
 * Frozen Step 0 artifacts that are shared across all downstream phases.
 *
 * This is the single authoritative source for Step 0 products.
 * Downstream code must read from this context, not from separate
 * copies on the state object.
 */
export interface PreAuditContext {
  localFindings: any[];
  step0Result?: Step0Result;
  webContextMap?: Record<string, string>;
  precedents?: Precedent[];
  stripped?: {
    original: string;
    bare: string;
    replacements: Array<{ original: string; placeholder: string }>;
  };
}

// ── Client Fingerprint ────────────────────────────────────────────────────────

/**
 * Lightweight, privacy-safe identifier for the connected Host.
 *
 * Used as part of the structured-observation cache key so that
 * observations about one Host are not incorrectly applied to another.
 */
export interface ClientFingerprint {
  name?: string;
  version?: string;
  transport?: string;
}

// ── Task Classification ───────────────────────────────────────────────────────

/** Coarse content-size bucket for observation-key scoping. */
export type TaskClass = "short" | "medium" | "long";

// ── Structured Observation Key ────────────────────────────────────────────────

/**
 * Composite cache key for HostStructuredObservation records.
 *
 * Observations are scoped to fingerprint + task class so that a
 * successful short-content run does not imply the same Host can
 * handle a 5000-word long-form audit.
 */
export interface StructuredObservationKey {
  fingerprint: ClientFingerprint;
  model?: string;
  protocolVersion: "kevlar-host-guided/v1";
  taskClass: TaskClass;
  locale?: string;
}

// ── Host Structured Observation ──────────────────────────────────────────────

/**
 * A cached observation about how a specific Host handled the structured
 * collaboration protocol for a given task class.
 */
export interface HostStructuredObservation {
  key: StructuredObservationKey;

  status: "format_verified" | "unsupported" | "failed";

  reason: "kevlar_result_schema_matched" | DispatchFailureReason;

  observedAt: number;
  expiresAt: number;

  /** True when this observation came from a lighter task class than the query. */
  isLighter?: boolean;
}
