/**
 * Kevlar Structured Logging — Event Names
 *
 * Central registry of all 100+ structured log event names.
 * Using constants prevents typos and enables IDE autocomplete / search.
 *
 * Categories:
 *   HANDSHAKE — MCP initialize, capability negotiation
 *   AUDIT     — System audit pipeline (pre-audit, cross-validation, arbitration)
 *   SAMPLING  — MCP sampling lifecycle (task-augmented, serial, degradation)
 *   PERSONA   — Persona CRUD and review execution
 *   WIZARD    — Wizard state machine transitions
 *   CONFIG    — Mode resolution, config persistence
 *   PRO       — Pro runtime, bundle sync, activation
 *   RULES     — Rule engine, strategy bundle
 *   TOOL      — MCP tool call dispatch
 *   SYSTEM    — Server lifecycle, locks, errors
 */

// ── Handshake ────────────────────────────────────────────────────────────────
export const EVENT_CLIENT_HANDSHAKE = "client_handshake" as const;
export const EVENT_HOST_EXEC_HANDSHAKE = "host_exec_handshake" as const;

// ── Audit Pipeline ───────────────────────────────────────────────────────────
export const EVENT_REVIEW_EXECUTE = "review_execute" as const;
export const EVENT_REVIEW_SUMMARY = "review_summary" as const;
export const EVENT_ORCH_STEP0_PARSED = "orchestration_step0_parsed" as const;
export const EVENT_ORCH_TURN2_PROCESSED = "orchestration_turn2_processed" as const;
export const EVENT_ORCH_TURN3_PROCESSED = "orchestration_turn3_processed" as const;
export const EVENT_SUBAGENT_AUDIT_PROCESSED = "subagent_audit_processed" as const;
export const EVENT_SYSTEM_AUDITOR_FAILED = "system_auditor_failed" as const;
export const EVENT_SYSTEM_AUDITORS_TIMEOUT = "system_auditors_timeout" as const;
export const EVENT_CROSS_VALIDATION_FAILED = "cross_validation_failed" as const;
export const EVENT_PRE_AUDIT_FINALIZER_FAILED = "pre_audit_finalizer_failed" as const;
export const EVENT_REVIEW_WIZARD_ERROR = "review_wizard_error" as const;

// ── Sampling / Execution ─────────────────────────────────────────────────────
export const EVENT_TASK_AUG_START = "task_augmented_sampling_start" as const;
export const EVENT_TASK_AUG_LAUNCHED = "task_augmented_launched" as const;
export const EVENT_TASK_AUG_USER_REJECTED = "task_augmented_user_rejected" as const;
export const EVENT_TASK_AUG_LAUNCH_FAILED = "task_augmented_launch_failed" as const;
export const EVENT_TASK_AUG_NO_POLL = "task_augmented_no_poll" as const;
export const EVENT_TASK_AUG_TOTAL_TIMEOUT = "task_augmented_total_timeout" as const;
export const EVENT_TASK_AUG_COMPLETED = "task_augmented_completed" as const;
export const EVENT_TASK_AUG_RESULT_FAILED = "task_augmented_result_failed" as const;
export const EVENT_TASK_AUG_INPUT_REQUIRED_FAILED = "task_augmented_input_required_failed" as const;
export const EVENT_TASK_AUG_REMOTE_FAILED = "task_augmented_remote_failed" as const;
export const EVENT_TASK_AUG_CANCELLED = "task_augmented_cancelled" as const;
export const EVENT_TASK_AUG_POLL_INVALID_PARAMS = "task_augmented_poll_invalid_params" as const;
export const EVENT_TASK_AUG_POLL_FAILED = "task_augmented_poll_failed" as const;
export const EVENT_TASK_AUG_COMPLETE = "task_augmented_sampling_complete" as const;
export const EVENT_SAMPLING_EXEC_TASK_AUG = "sampling_exec_task_augmented" as const;
export const EVENT_SAMPLING_EXEC_TASK_AUG_SUCCESS = "sampling_exec_task_augmented_success" as const;
export const EVENT_SAMPLING_EXEC_DEGRADE_SERIAL = "sampling_exec_degrade_to_serial" as const;
export const EVENT_SAMPLING_EXEC_SERIAL = "sampling_exec_serial" as const;
export const EVENT_SAMPLING_EXEC_SERIAL_SUCCESS = "sampling_exec_serial_success" as const;
export const EVENT_SAMPLING_EXEC_DEGRADE_ORCH = "sampling_exec_degrade_to_orchestration" as const;
export const EVENT_SAMPLING_FALLBACK_ORCH = "sampling_fallback_to_orchestration" as const;
export const EVENT_SAMPLING_REJECTED = "sampling_rejected" as const;
export const EVENT_SAMPLING_CANCEL_TERMINAL = "sampling_cancel_terminal" as const;

// ── Mode / Config / Execution ────────────────────────────────────────────────
export const EVENT_MODE_SILENT_DOWNGRADE = "mode_silent_downgrade" as const;
export const EVENT_MODE_INVALID_CONFIG = "mode_invalid_config" as const;
export const EVENT_MODE_PERSIST = "mode_persist" as const;
export const EVENT_MODE_ENV = "mode_env" as const;
export const EVENT_EXEC_PLAN_RESOLVED = "execution_plan_resolved" as const;
export const EVENT_EXEC_DOWNGRADED = "execution_downgraded" as const;
export const EVENT_HOST_ORCH_STRATEGY = "host_orchestration_strategy" as const;
export const EVENT_LOCK_TTL_OVERRIDE = "lock_ttl_override" as const;
export const EVENT_CONFIG_NOT_INITIALIZED = "config_not_initialized" as const;
export const EVENT_CONFIG_UPDATE = "config_update" as const;
export const EVENT_CONFIG_WRITE_ERROR = "config_write_error" as const;

// ── Persona ──────────────────────────────────────────────────────────────────
export const EVENT_PERSONA_READ_ERROR = "persona_read_error" as const;
export const EVENT_PERSONA_PARSE_ERROR = "persona_parse_error" as const;
export const EVENT_PERSONA_WRITE_ERROR = "persona_write_error" as const;
export const EVENT_PERSONA_WRITTEN = "persona_written" as const;
export const EVENT_PERSONA_DELETED = "persona_deleted" as const;
export const EVENT_PERSONA_FAILED = "persona_failed" as const;

// ── Wizard ───────────────────────────────────────────────────────────────────
export const EVENT_WIZARD_ERROR = "wizard_error" as const;
export const EVENT_CLEAN_STALE_WIZARD = "clean_stale_wizard" as const;

// ── Pro ──────────────────────────────────────────────────────────────────────
export const EVENT_PRO_RUNTIME_LOADED = "pro_runtime_loaded" as const;
export const EVENT_PRO_RUNTIME_UNAVAILABLE = "pro_runtime_unavailable" as const;
export const EVENT_VERSION_CHECK_COMPLETE = "version_check_complete" as const;
export const EVENT_BUNDLE_CACHE_LOADED = "bundle_cache_loaded" as const;

// ── Rules ────────────────────────────────────────────────────────────────────
export const EVENT_RULES_INDEX_BUILT = "rules_index_built" as const;
export const EVENT_RULES_EMPTY_FALLBACK = "rules_empty_fallback" as const;

// ── Tool Dispatch ────────────────────────────────────────────────────────────
export const EVENT_TOOL_CALLED = "tool_called" as const;
export const EVENT_TOOL_COMPLETED = "tool_completed" as const;
export const EVENT_TOOL_ERROR = "tool_error" as const;
export const EVENT_UNKNOWN_TOOL = "unknown_tool" as const;

// ── Retry ────────────────────────────────────────────────────────────────────
export const EVENT_RETRY = "retry" as const;
