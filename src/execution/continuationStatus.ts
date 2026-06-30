/**
 * Structured Continuation Status Protocol
 *
 * Wraps all review_content_wizard_continue tool responses in a
 * machine-parseable JSON envelope so the host AI can read status
 * fields directly instead of parsing natural-language error strings.
 *
 * Format embedded in ToolResult text content:
 *   [KEVLAR_STATUS]
 *   { ... json ... }
 *   [/KEVLAR_STATUS]
 *
 *   Human-readable description follows the marker block.
 */

const STATUS_MARKER_OPEN = "[KEVLAR_STATUS]";
const STATUS_MARKER_CLOSE = "[/KEVLAR_STATUS]";

// ── Types ────────────────────────────────────────────────────────────────────

export type ContinuationStatusCode =
  | "accepted"
  | "rejected"
  | "degraded"
  | "progress";

export type ContinuationReasonCode =
  // Rejected
  | "missing_session_id"
  | "invalid_session_id_format"
  | "session_expired"
  | "invalid_continuation_id_format"
  | "stale_revision"
  | "no_active_continuation"
  | "continuation_id_mismatch"
  | "checkpoint_mismatch"
  | "gate_validation_failed"
  | "invalid_execution_receipt"
  | "invalid_step"
  | "pro_only"
  | "invalid_agent_id_format"
  | "unknown_agent_id"
  | "invalid_json"
  | "agent_result_format_error"
  | "slots_full"
  | "all_agents_failed"
  // Degraded
  | "continuation_expired"
  | "max_retries_exceeded"
  | "schema_mismatch"
  | "subagent_fallback"
  // Progress
  | "slot_received";

export interface ContinuationStatusResult {
  status: ContinuationStatusCode;
  reason: ContinuationReasonCode;
  retry: boolean;
  /** Machine-readable details for the host AI to act on */
  details?: Record<string, unknown>;
}

// ── Builders ─────────────────────────────────────────────────────────────────

/** Create a structured rejection response. */
export function rejected(reason: ContinuationReasonCode, details?: Record<string, unknown>): ContinuationStatusResult {
  return { status: "rejected", reason, retry: false, details };
}

/** Create a structured degradation response (e.g. expired → orchestration). */
export function degraded(reason: ContinuationReasonCode, details?: Record<string, unknown>): ContinuationStatusResult {
  return { status: "degraded", reason, retry: false, details };
}

/** Create a structured progress response (e.g. slot received, more pending). */
export function progress(reason: ContinuationReasonCode, details?: Record<string, unknown>): ContinuationStatusResult {
  return { status: "progress", reason, retry: true, details };
}

// ── Format / Parse ───────────────────────────────────────────────────────────

/** Serialise a status result into the wire format string. */
export function formatStatus(status: ContinuationStatusResult): string {
  return [
    STATUS_MARKER_OPEN,
    JSON.stringify(status),
    STATUS_MARKER_CLOSE,
  ].join("\n");
}

/**
 * Build a complete ToolResult text content string:
 * structured status envelope + optional human-readable message.
 */
export function formatStatusMessage(
  status: ContinuationStatusResult,
  humanMessage: string,
): string {
  return formatStatus(status) + "\n\n" + humanMessage;
}

/** Parse the structured status envelope from a text string (returns null if not found). */
export function parseStatus(text: string): ContinuationStatusResult | null {
  const startIdx = text.indexOf(STATUS_MARKER_OPEN);
  if (startIdx === -1) return null;

  const bodyStart = startIdx + STATUS_MARKER_OPEN.length;
  const endIdx = text.indexOf(STATUS_MARKER_CLOSE, bodyStart);
  if (endIdx === -1) return null;

  try {
    return JSON.parse(text.slice(bodyStart, endIdx).trim());
  } catch {
    return null;
  }
}
