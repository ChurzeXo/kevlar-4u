/**
 * Host Structured Observation Cache (v3)
 *
 * Persistent observation store that remembers how a Host behaved during
 * a structured collaboration attempt. Observations are keyed by
 * fingerprint + taskClass + model + locale so a successful short-text
 * audit does not incorrectly license a long-text structured attempt.
 *
 * Key design rules:
 * - Based on actual observations, NOT name-based whitelists
 * - TTL-based auto-expiry per reason category
 * - Host version/transport change invalidates cache
 * - KEVLAR_FORCE_HOST_STRUCTURED=true bypasses cache
 *
 * File: tmpDir/kevlar-observations.json
 */

import * as fs from "fs";
import * as path from "path";
import type {
  ClientFingerprint,
  TaskClass,
  StructuredObservationKey,
  HostStructuredObservation,
  HostStructuredCapabilityStatus,
} from "./plan.js";
import type { DispatchFailureReason } from "./plan.js";

// ── TTL Map ───────────────────────────────────────────────────────────────────

const OBSERVATION_TTL: Record<string, number> = {
  // Positive observation: Host can reliably output Kevlar schema
  kevlar_result_schema_matched: 7 * 24 * 60 * 60 * 1000,  // 7 days

  // Negative observations
  unsupported:        24 * 60 * 60 * 1000,    // 24 hours
  schema_mismatch:    24 * 60 * 60 * 1000,    // 24 hours
  invalid_json:       24 * 60 * 60 * 1000,    // 24 hours
  host_rejected:      24 * 60 * 60 * 1000,    // 24 hours
  no_response:        24 * 60 * 60 * 1000,    // 24 hours

  // Truncation: likely a budget issue, retry sooner
  likely_output_truncated: 1 * 60 * 60 * 1000, // 1 hour
};

// ── Task Class Inference ──────────────────────────────────────────────────────

/** Heuristic content size estimation (chars → taskClass). */
const TASK_CLASS_THRESHOLDS: Record<TaskClass, number> = {
  short:  0,
  medium: 800,
  long:   3000,
};

function classifyTaskClass(charCount: number): TaskClass {
  if (charCount >= TASK_CLASS_THRESHOLDS.long) return "long";
  if (charCount >= TASK_CLASS_THRESHOLDS.medium) return "medium";
  return "short";
}

export function inferTaskClass(content?: string): TaskClass {
  if (!content) return "short";
  return classifyTaskClass(content.length);
}

// ── Cache Read/Write ──────────────────────────────────────────────────────────

let cacheDir: string | null = null;

/** Set the directory for observation cache storage. Called once at server init. */
export function setObservationCacheDir(dir: string): void {
  cacheDir = dir;
}

function getObservationCachePath(): string {
  return path.join(cacheDir ?? "/tmp", "kevlar-observations.json");
}

interface ObservationCacheFile {
  version: 1;
  observations: HostStructuredObservation[];
  updatedAt: number;
}

function loadObservationsInternal(): HostStructuredObservation[] {
  if (process.env.KEVLAR_FORCE_HOST_STRUCTURED === "true") return [];

  const filePath = getObservationCachePath();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: ObservationCacheFile = JSON.parse(raw);
    if (parsed.version !== 1) return [];
    return parsed.observations ?? [];
  } catch {
    return [];
  }
}

function saveObservationsInternal(observations: HostStructuredObservation[]): void {
  const filePath = getObservationCachePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const cacheFile: ObservationCacheFile = {
    version: 1,
    observations,
    updatedAt: Date.now(),
  };
  fs.writeFileSync(filePath, JSON.stringify(cacheFile, null, 2), "utf-8");
}

// ── Fingerprint Matching ──────────────────────────────────────────────────────

function fingerprintMatches(
  a: ClientFingerprint | undefined,
  b: ClientFingerprint | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.name === b.name &&
    a.version === b.version &&
    a.transport === b.transport
  );
}

// ── Key Matching (fuzzy: same fingerprint + taskClass or smaller) ──────────────

const TASK_CLASS_RANK: Record<TaskClass, number> = {
  short: 0,
  medium: 1,
  long: 2,
};

function keyMatches(
  stored: StructuredObservationKey,
  query: StructuredObservationKey,
): "exact" | "lighter" | "none" {
  if (!fingerprintMatches(stored.fingerprint, query.fingerprint)) return "none";
  if (stored.protocolVersion !== query.protocolVersion) return "none";

  // Model key: present in both, must match; absent in either → skip match
  if (stored.model && query.model && stored.model !== query.model) return "none";

  // Locale: same logic
  if (stored.locale && query.locale && stored.locale !== query.locale) return "none";

  // Task class matching: heavier stored observation can satisfy lighter queries,
  // but lighter stored observations CANNOT satisfy heavier queries.
  if (stored.taskClass === query.taskClass) return "exact";
  if (TASK_CLASS_RANK[stored.taskClass] > TASK_CLASS_RANK[query.taskClass]) return "exact";
  // stored task is lighter than query → match exists but at lower confidence
  return "lighter";
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up a cached observation for the given key.
 *
 * Returns the observation if:
 * - fingerprint, protocolVersion, model, locale match (or absent)
 * - taskClass is >= query.taskClass (or same → exact, smaller → lighter)
 * - observation hasn't expired
 *
 * Returns undefined if no matching, unexpired observation exists.
 */
export function getHostStructuredObservation(
  key: StructuredObservationKey,
): HostStructuredObservation | undefined {
  const all = loadObservationsInternal();
  const now = Date.now();

  // Prefer exact match
  let bestMatch: HostStructuredObservation | undefined;
  let bestRank: "exact" | "lighter" = "lighter";

  for (const obs of all) {
    const match = keyMatches(obs.key, key);
    if (match === "none") continue;

    // Check expiry
    if (obs.expiresAt < now) continue;

    if (match === "exact") {
      bestMatch = obs;
      bestRank = "exact";
      break; // exact match wins immediately
    }

    // lighter match: take the most recent if multiple
    if (match === "lighter" && (!bestMatch || obs.observedAt > bestMatch.observedAt)) {
      bestMatch = obs;
      bestRank = "lighter";
    }
  }

  if (bestMatch && bestRank === "lighter") {
    return {
      ...bestMatch,
      status: "format_verified" as const,
      isLighter: true,
    };
  }

  return bestMatch;
}

/**
 * Record a new observation in the cache.
 *
 * - Expired observations matching the same key are purged first.
 * - TTL is determined by the observation reason.
 * - If KEVLAR_FORCE_HOST_STRUCTURED is set, observations are not persisted.
 */
export function recordHostStructuredObservation(
  observation: Omit<HostStructuredObservation, "observedAt" | "expiresAt">,
): void {
  if (process.env.KEVLAR_FORCE_HOST_STRUCTURED === "true") return;

  const all = loadObservationsInternal();
  const now = Date.now();

  // Purge expired entries and entries for same host identity (name+transport)
  // but different version — newer version supercedes older.
  const active = all.filter((obs) => {
    if (obs.expiresAt < now) return false;
    // Purge entries for same host identity but different version
    const storedFp = obs.key.fingerprint;
    const newFp = observation.key.fingerprint;
    if (
      storedFp && newFp &&
      storedFp.name === newFp.name &&
      storedFp.transport === newFp.transport &&
      storedFp.version !== newFp.version
    ) {
      return false;
    }
    return true;
  });

  const ttl = OBSERVATION_TTL[observation.reason] ?? OBSERVATION_TTL.schema_mismatch;
  const newObs: HostStructuredObservation = {
    ...observation,
    observedAt: now,
    expiresAt: now + ttl,
  };

  active.push(newObs);
  saveObservationsInternal(active);
}

/**
 * Record a capability observation from a structured result classification.
 *
 * Convenience wrapper that creates the full observation with key, status, and reason.
 */
export function recordCapabilityObservation(
  fingerprint: ClientFingerprint,
  taskClass: TaskClass,
  status: Exclude<HostStructuredCapabilityStatus, "unknown">,
  reason: DispatchFailureReason | "kevlar_result_schema_matched",
  options?: { model?: string; locale?: string },
): void {
  recordHostStructuredObservation({
    key: {
      fingerprint,
      model: options?.model,
      protocolVersion: "kevlar-host-guided/v1",
      taskClass,
      locale: options?.locale,
    },
    status,
    reason,
  });
}

/**
 * Get all non-expired observations (for debugging/telemetry).
 */
export function listObservations(): HostStructuredObservation[] {
  const all = loadObservationsInternal();
  const now = Date.now();
  return all.filter((obs) => obs.expiresAt >= now);
}

/**
 * Purge all observations (for testing/manual reset).
 */
export function clearObservations(): void {
  saveObservationsInternal([]);
}
