/**
 * Checkpoint & Execution Transition System (v3)
 *
 * Defines the audit state machine checkpoints and the ExecutionTransition
 * record that captures downgrade events when a structured collaboration
 * attempt fails and Kevlar falls back to standard host orchestration.
 */

import type { ExecutionPlan, DispatchFailureReason, ClientFingerprint, HostStructuredCapabilityStatus } from "./plan.js";
import { getClientFingerprint } from "./client.js";
import { logger } from "../utils/logger.js";

// ── Audit Checkpoints ─────────────────────────────────────────────────────────

/**
 * Key milestones in the review wizard state machine.
 *
 * Structured collaboration is initiated after `step0_completed`.
 * If it fails, the state machine resumes from `step0_completed`
 * with `strategy: "standard"`.
 */
export type AuditCheckpoint =
  | "initiated"
  | "step0_completed"
  | "preaudit_started"
  | "preaudit_completed"
  | "persona_inventory_completed"
  | "persona_audit_started";

// ── Execution Transition ──────────────────────────────────────────────────────

/**
 * Immutable record of a downgrade event.
 *
 * Created when a structured collaboration attempt fails and Kevlar
 * switches to standard host orchestration. Appended to the
 * executionTransitions log for observability.
 */
export interface ExecutionTransition {
  /** The ExecutionPlan before the downgrade. */
  from: ExecutionPlan;
  /** The ExecutionPlan after the downgrade. */
  to: ExecutionPlan;
  /** What caused the structured attempt to fail. */
  reason: DispatchFailureReason;
  /** Unix timestamp (ms) when the transition occurred. */
  at: number;
  /** Which checkpoint the state machine will resume from. */
  checkpoint: AuditCheckpoint;
  /** Fingerprint of the Host that was being used (for telemetry). */
  clientFingerprint?: ClientFingerprint;
}

// ── Resume-from-Failure Interface ─────────────────────────────────────────────

/**
 * Minimal wizard state shape required by resumeFromStructuredFailure().
 *
 * This avoids circular imports by not depending on the full ReviewWizardState
 * from the tools layer. Any wizard state that satisfies this interface
 * can be passed to the resume function.
 */
export interface StructuredFailureResumeState {
  executionPlan?: ExecutionPlan;
  checkpoint?: AuditCheckpoint;
  structuredDowngraded?: boolean;
  capabilityStatus?: HostStructuredCapabilityStatus;
  executionTransitions?: ExecutionTransition[];
}

/**
 * Recover from a failed structured collaboration attempt.
 *
 * - Switches executionPlan to `host_orchestration + standard`
 * - Marks `structuredDowngraded = true` to prevent repeated attempts
 * - Resets checkpoint to `step0_completed`
 * - Sets capabilityStatus based on the failure reason
 * - Appends an ExecutionTransition for observability
 *
 * The caller must separately handle:
 * - Preserving Step 0 artifacts (preAuditContext, content, tier, etc.)
 * - Cleaning structured attempt scratch fields
 * - Restarting the audit pipeline from step0_completed
 */
export function resumeFromStructuredFailure(
  state: StructuredFailureResumeState,
  reason: DispatchFailureReason,
): {
  executionPlan: ExecutionPlan;
  checkpoint: AuditCheckpoint;
  structuredDowngraded: true;
  capabilityStatus: HostStructuredCapabilityStatus;
  executionTransitions: ExecutionTransition[];
} {
  const from = state.executionPlan ?? {
    backend: "host_orchestration" as const,
    strategy: "structured" as const,
  };

  const to: ExecutionPlan = {
    backend: "host_orchestration" as const,
    strategy: "standard" as const,
  };

  const transition: ExecutionTransition = {
    from,
    to,
    reason,
    at: Date.now(),
    checkpoint: "step0_completed",
    clientFingerprint: getClientFingerprint(),
  };

  logger.warn("Execution downgraded", {
    event: "execution_downgraded",
    from: `${from.backend}/${from.strategy}`,
    to: `${to.backend}/${to.strategy}`,
    reason,
    checkpoint: "step0_completed",
  });

  return {
    executionPlan: to,
    checkpoint: "step0_completed",
    structuredDowngraded: true,
    capabilityStatus:
      reason === "host_rejected" ? "unsupported" : "failed",
    executionTransitions: [
      ...(state.executionTransitions ?? []),
      transition,
    ],
  };
}
