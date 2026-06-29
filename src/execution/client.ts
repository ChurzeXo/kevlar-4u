/**
 * MCP Client Capability Detection (MECP §1)
 *
 * Negotiates capabilities with the host client using a versioned schema
 * similar to HTTP content negotiation.
 *
 * v3 revision replaces name-based heuristics with an optimistic approach
 * and adds structured-result classification for host orchestration.
 */

import type {
  ClientFingerprint,
  HostStructuredCapabilityStatus,
  DispatchFailureReason,
} from "./plan.js";
import { logger } from "../utils/logger.js";
import { log } from "../utils/logCategories.js";
import * as fs from "fs";
import * as path from "path";

// ── Capability Interfaces (MECP §1) ────────────────────────────────────────────

export interface CapabilityDetail {
  supported: boolean;
  version?: string;
}

export interface Capabilities {
  sampling: CapabilityDetail;
  structuredOutput: CapabilityDetail;
  vision: CapabilityDetail;
  toolCalling: CapabilityDetail;
}

// ── Client Info Store ─────────────────────────────────────────────────────────

let clientInfo: { name: string; version?: string } | null = null;
let clientCapabilities: Record<string, unknown> | null = null;
let rawInitializeParams: Record<string, unknown> | null = null;

/**
 * Lazy provider for client info, invoked on first access when {@link clientInfo}
 * is still null. Set during server setup; the provider is called at tool
 * invocation time (after the MCP initialize handshake), not at construction time.
 */
let clientInfoProvider: (() => { name: string; version?: string } | null) | null = null;

export function setClientInfo(name: string, version?: string): void {
  clientInfo = { name: name.toLowerCase(), version };
}

/** Register a lazy getter that will be tried when clientInfo hasn't been set yet. */
export function setClientInfoProvider(
  provider: () => { name: string; version?: string } | null,
): void {
  clientInfoProvider = provider;
}

export function setClientCapabilities(caps: Record<string, unknown> | null): void {
  clientCapabilities = caps;
}

export function setRawInitializeParams(params: Record<string, unknown> | null): void {
  rawInitializeParams = params;
}

/**
 * Try to fill clientInfo from the lazy provider if it hasn't been set.
 * Safe to call multiple times — only fires the provider once.
 */
function ensureClientInfo(): void {
  if (!clientInfo && clientInfoProvider) {
    const info = clientInfoProvider();
    if (info) {
      setClientInfo(info.name, info.version);
    }
  }
}

/**
 * Lazy provider for client capabilities, invoked on first access when
 * {@link clientCapabilities} is still null. Same rationale as clientInfo:
 * set during server setup, called at tool invocation time (after the MCP
 * initialize handshake).
 */
let clientCapabilitiesProvider: (() => Record<string, unknown> | null) | null = null;

/** Register a lazy getter that will be tried when clientCapabilities hasn't been set yet. */
export function setClientCapabilitiesProvider(
  provider: () => Record<string, unknown> | null,
): void {
  clientCapabilitiesProvider = provider;
}

/** Try to fill clientCapabilities from the lazy provider. Idempotent. */
function ensureClientCapabilities(): void {
  if (!clientCapabilities && clientCapabilitiesProvider) {
    const caps = clientCapabilitiesProvider();
    if (caps) {
      setClientCapabilities(caps);
    }
  }
}

// ── Client Fingerprint ────────────────────────────────────────────────────────

/**
 * Build a lightweight, privacy-safe identifier for the connected Host.
 *
 * The fingerprint is used as part of the structured-observation cache key
 * so that observations about one Host (e.g. "CodeBuddy v2.3") are not
 * incorrectly applied to another.
 */
export function getClientFingerprint(): ClientFingerprint {
  ensureClientInfo();
  return {
    name: clientInfo?.name,
    version: clientInfo?.version,
    transport: "stdio", // Kevlar only supports stdio transport
  };
}

// ── Individual Capability Checks ──────────────────────────────────────────────

export function isSamplingSupported(): boolean {
  // Lazy-init: try the provider if clientCapabilities wasn't set at construction time
  ensureClientCapabilities();

  // Primary: check client-declared MCP capabilities (spec §5.2)
  const hasSampling = clientCapabilities?.sampling !== undefined;

  const result = hasSampling;
  log.handshake.debug("Sampling support resolved", {
    event: "sampling_support_resolved",
    hasSamplingCap: hasSampling,
    result,
  });
  return result;
}

/**
 * Check if the client supports task-augmented sampling (true parallel execution).
 *
 * Per MCP spec (2025-11-25 experimental): requires the client to declare
 * `capabilities.tasks.requests.sampling.createMessage`.
 *
 * If not declared, Kevlar MUST NOT attach the `task` field to
 * `sampling/createMessage` requests.
 */
export function isTaskAugmentedSamplingSupported(): boolean {
  ensureClientCapabilities();

  const tasksCap = clientCapabilities?.tasks as Record<string, unknown> | undefined;
  if (!tasksCap) return false;

  const requestsCap = tasksCap.requests as Record<string, unknown> | undefined;
  if (!requestsCap) return false;

  const samplingCap = requestsCap.sampling as Record<string, unknown> | undefined;
  if (!samplingCap) return false;

  return samplingCap.createMessage !== undefined;
}

/**
 * Check if the client supports task cancellation.
 *
 * Per MCP spec: `tasks.cancel` is an INDEPENDENT capability declaration,
 * NOT bundled with `tasks.requests.sampling.createMessage`.
 *
 * If not declared, Kevlar MUST NOT call `tasks/cancel`.
 */
export function isTaskCancelSupported(): boolean {
  ensureClientCapabilities();

  const tasksCap = clientCapabilities?.tasks as Record<string, unknown> | undefined;
  if (!tasksCap) return false;

  return tasksCap.cancel !== undefined;
}

export function isStructuredOutputSupported(): boolean {
  return clientCapabilities?.structuredOutput !== undefined;
}

/**
 * Host execution capability as declared by the client during MCP handshake
 * under `capabilities.experimental["kevlar.host.execution/v1"]`.
 */
export interface HostExecutionCapability {
  version?: string;
  ephemeralAgents?: {
    supported?: boolean;
    modes?: string[];
    maxConcurrent?: number;
    contextIsolation?: {
      supported?: boolean;
      guaranteeLevel?: string;
    };
    output?: {
      structured?: boolean;
      streaming?: boolean;
    };
  };
  sampling?: {
    supported?: boolean;
    maxConcurrency?: number;
  };
  orchestration?: {
    supported?: boolean;
  };
}

let hostExecCapLogged = false;

/**
 * Directory for writing host-exec-handshake.json dump file.
 * This file is for debugging/verification only — safe to delete.
 * Set via setHandshakeDumpDir() during server init.
 */
let handshakeDumpDir: string | null = null;

export function setHandshakeDumpDir(dir: string): void {
  handshakeDumpDir = dir;
}

/**
 * Extract the host's execution capability declaration from client capabilities.
 * Returns null if the client did not declare `kevlar.host.execution/v1`.
 * On first access, writes a full handshake analysis dump (host-exec-handshake.json)
 * covering all MCP capabilities per the audit-hybrid-execution.md specification:
 *   - sampling (serial blocking)
 *   - tasks.requests.sampling.createMessage (task-augmented parallel)
 *   - tasks.cancel (independent cancel capability)
 *   - kevlar.host.execution/v1 (Kevlar experimental)
 */
export function getHostExecutionCapability(): HostExecutionCapability | null {
  ensureClientCapabilities();
  const experimental = clientCapabilities?.experimental as Record<string, unknown> | undefined;

  function dumpHandshake(payload: Record<string, unknown>): void {
    if (!handshakeDumpDir) return;
    try {
      const filePath = path.join(handshakeDumpDir, "host-exec-handshake.json");
      fs.mkdirSync(handshakeDumpDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
      const readmePath = path.join(handshakeDumpDir, "host-exec-handshake.README.txt");
      fs.writeFileSync(
        readmePath,
        "此目录及文件为 kevlar-4u MCP 握手能力协商的调试输出，仅用于验证。\n" +
        "不需要时可以整个删除 host-exec-handshake.* 文件。\n",
        "utf-8",
      );
    } catch {
      // Best-effort: ignore filesystem errors
    }
  }

  if (hostExecCapLogged) {
    const cap = experimental?.["kevlar.host.execution/v1"];
    return (cap && typeof cap === "object") ? (cap as HostExecutionCapability) : null;
  }

  hostExecCapLogged = true;
  ensureClientInfo();

  const cap = experimental?.["kevlar.host.execution/v1"];
  const declared = cap !== undefined && cap !== null && typeof cap === "object";

  // Resolve all MCP capabilities per audit-hybrid-execution.md §能力声明前提
  const taskAugSampling = isTaskAugmentedSamplingSupported();
  const taskCancel = isTaskCancelSupported();
  const hasSampling = isSamplingSupported();

  const payload = {
    clientName: clientInfo?.name ?? "unknown",
    clientVersion: clientInfo?.version ?? "unknown",
    rawInitializeParams: rawInitializeParams ?? null,
    rawClientCapabilities: clientCapabilities ?? null,

    // Per audit doc lines 73-86: MCP capability declarations
    mcpCapabilities: {
      sampling: {
        declared: hasSampling,
        description: "普通串行 sampling — Server 发出请求，Client 同步阻塞返回",
      },
      taskAugmented: {
        declared: taskAugSampling,
        capabilityPath: "tasks.requests.sampling.createMessage",
        description: "task-augmented sampling (2025-11-25) — 真并行 O(T)",
      },
      taskCancel: {
        declared: taskCancel,
        capabilityPath: "tasks.cancel",
        description: "任务取消能力（独立声明，未声明时 MUST NOT 调用 tasks/cancel）",
      },
    },

    // Resolution: which backend will be used
    resolution: {
      taskAugmentedAvailable: taskAugSampling,
      serialSamplingAvailable: isSamplingSupported(),
      recommendedBackend: taskAugSampling
        ? "sampling_task_augmented"
        : isSamplingSupported()
          ? "sampling_serial"
          : "host_orchestration",
    },

    kevlarHostExec: {
      declared,
      capability: declared ? cap : null,
    },
  };

  logger.debug("Host execution capability from handshake", {
    event: "host_exec_handshake",
    ...payload,
  });
  dumpHandshake(payload);

  return declared ? (cap as HostExecutionCapability) : null;
}

/**
 * Detect if the host AI supports subagent dispatch.
 *
 * @deprecated Since v3, this always returns true (optimistic approach).
 * Kevlar no longer attempts to detect "real" Subagent capability through
 * name-based heuristics. The Host is always assumed capable of structured
 * collaboration; actual capability is verified at runtime through the
 * structured-result classification flow.
 *
 * Previously this function used name-based string matching on clientInfo.name
 * to guess subagent support. That approach had structural problems:
 * - False negatives for unknown clients
 * - False positives for clients whose MCP connector doesn't route Task tools
 * - Conceptual confusion between JSON formatting and real task dispatch
 */
export function isSubagentDispatchSupported(): boolean {
  // If explicitly disabled via env var, still honor the override
  if (process.env.KEVLAR_DISABLE_SUBAGENT === "true") return false;

  // Optimistic: assume the Host can participate in structured collaboration.
  // Actual capability is verified at runtime via classifyHostStructuredResult().
  return true;
}

// ── Composite Capability Query (MECP §1) ──────────────────────────────────────

export function getCapabilities(): Capabilities {
  const sampling = isSamplingSupported();
  return {
    sampling: { supported: sampling },
    structuredOutput: { supported: isStructuredOutputSupported() },
    vision: { supported: false },
    toolCalling: { supported: true },
  };
}

export function getCapabilitiesSummary(): string {
  const caps = getCapabilities();
  const lines: string[] = [];
  if (caps.sampling.supported) lines.push("sampling");
  if (caps.structuredOutput.supported) lines.push("structured output");
  if (caps.toolCalling.supported) lines.push("tool calling");
  return lines.length > 0 ? lines.join(", ") : "none detected";
}

// ── Structured Result Classification ──────────────────────────────────────────

/**
 * Safe JSON parse that never throws.
 */
function tryParseJson(raw: string):
  | { ok: true; value: unknown }
  | { ok: false; error: Error } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error("invalid_json") };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Detect explicit host rejection of the structured collaboration protocol.
 *
 * Only checks protocol control fields — does NOT scan raw text.
 * Reviewer findings may contain natural language like "not supported by
 * evidence" that should NOT be misinterpreted as Host rejection.
 */
export function isExplicitHostRejection(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  return (
    parsed.protocol === "kevlar-host-guided/v1" &&
    parsed.status === "rejected"
  );
}

/**
 * Verify that a parsed JSON object conforms to the Kevlar host-guided
 * result schema: protocol marker + completed status + non-empty dimensions.
 */
export function isKevlarHostGuidedResult(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  if (parsed.protocol !== "kevlar-host-guided/v1") return false;
  if (parsed.status !== "completed") return false;
  if (!Array.isArray(parsed.dimensions) || parsed.dimensions.length === 0) return false;

  return parsed.dimensions.every((dimension) => {
    if (!isRecord(dimension)) return false;
    return (
      typeof dimension.id === "string" &&
      dimension.id.length > 0 &&
      Array.isArray(dimension.findings)
    );
  });
}

/**
 * Count unclosed JSON structural characters to detect truncation.
 * Returns the net depth of unclosed { [ structures.
 */
function getJsonStructureDepth(raw: string): number {
  let depth = 0;
  for (const ch of raw) {
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return Math.max(0, depth);
}

/**
 * Rough token count estimation (~4 chars per token for English, ~1.5 for CJK).
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch >= "\u4e00" && ch <= "\u9fff") cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/**
 * Heuristic: does the raw response look like it was truncated mid-output?
 *
 * Only returns true when multiple signals agree:
 * - Unclosed JSON structures
 * - AND (abrupt ending OR near token budget)
 */
function looksLikelyTruncated(raw: string, maxTokens?: number): boolean {
  const trimmed = raw.trim();
  const hasUnclosedStructure = getJsonStructureDepth(trimmed) > 0;
  const endsAbruptly = /[:,]$/.test(trimmed) || !/[}\]"'`]$/.test(trimmed);
  const nearBudget = maxTokens !== undefined && estimateTokens(trimmed) >= maxTokens * 0.9;
  return hasUnclosedStructure && (endsAbruptly || nearBudget);
}

/**
 * Classify the raw text output from a host structured collaboration attempt.
 *
 * Four-step judgment:
 *   1. Empty response → failed / no_response
 *   2. Invalid JSON → failed / invalid_json (or likely_output_truncated)
 *   3. Explicit rejection → unsupported / host_rejected
 *   4. Schema match → format_verified / kevlar_result_schema_matched
 *
 * "JSON parseable" is NOT sufficient for schema success.
 */
export function classifyHostStructuredResult(
  raw: string | undefined,
  options?: { maxTokens?: number },
): {
  status: HostStructuredCapabilityStatus;
  reason: "kevlar_result_schema_matched" | DispatchFailureReason;
} {
  if (!raw?.trim()) {
    return { status: "failed", reason: "no_response" };
  }

  const parsedResult = tryParseJson(raw);

  if (!parsedResult.ok) {
    return {
      status: "failed",
      reason: looksLikelyTruncated(raw, options?.maxTokens)
        ? "likely_output_truncated"
        : "invalid_json",
    };
  }

  const parsed = parsedResult.value;

  if (isExplicitHostRejection(parsed)) {
    return { status: "unsupported", reason: "host_rejected" };
  }

  if (!isKevlarHostGuidedResult(parsed)) {
    return { status: "failed", reason: "schema_mismatch" };
  }

  return { status: "format_verified", reason: "kevlar_result_schema_matched" };
}
