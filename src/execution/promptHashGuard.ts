/**
 * Runtime Prompt Hash Guard
 *
 * P0 integrity verification for prompt content loaded at runtime.
 *
 * Why:
 *   CI hash baselines (prompt-hash-baselines.test.ts) only catch drift during
 *   PR checks. In production, a tampered free.json or alias-map file silently
 *   degrades prompts with no alert. This module closes that gap.
 *
 * What it checks:
 *   1. Alias map internal hash (stored hash vs computed SHA-256 of mappings)
 *   2. Alias map against embedded baseline hash (tamper-proof reference)
 *   3. Resolved prompt segments against embedded baseline hashes
 *
 * Failure behavior by tier:
 *   Free: log ERROR, continue serving (risk flagged, not blocked)
 *   Pro:  reject execution, fallback to Free tier
 */

import { createHash } from "node:crypto";
import type { PromptAliasMap } from "./promptAlias.js";
import { logger } from "../utils/observability.js";

// ── Types ────────────────────────────────────────────────────────────

export interface HashBaseline {
  /** What we're hashing */
  target: "alias_map" | "resolved_segment" | "full_prompt";
  /** Which locale / segment key */
  scope: string;
  /** Expected SHA-256 hex */
  expectedHash: string;
  /** Severity if mismatch */
  severity: "error" | "warn";
}

/** Result of a prompt integrity check. */
export interface IntegrityResult {
  ok: boolean;
  failures: string[];
}

// ── Embedded Baselines ────────────────────────────────────────────────
//
// These are extracted from:
//   src/__tests__/prompt-hash-baselines.test.ts  (CI baselines)
//   skills/templates/alias-maps/zh-CN.json        (alias map hash)
//   skills/templates/free.json                    (resolved segment hashes)
//
// When ANY of these change intentionally (e.g. a prompt tuning pass):
//   1. Run the CI hash baseline tests to get new expected hashes
//   2. Update the BASELINES array below
//   3. Commit both the template changes AND this file together

const BASELINES: HashBaseline[] = [
  // ── Alias map integrity ──────────────────────────────────────────
  {
    target: "alias_map",
    scope: "zh-CN",
    expectedHash: "3ca785fa179bad96667191f4ec9bfd65e13fbd290b1315a328a68d2437b778b4",
    severity: "error",
  },

  // ── Key resolved segments (alias-expanded, as served to LLM) ────
  // These 4 segments are the core reasoning framework — the "IP" of Kevlar.
  // If any of these change without a corresponding baseline update, it
  // indicates either tampering or an unversioned template edit.
  {
    target: "resolved_segment",
    scope: "coreReasoningFramework",
    expectedHash: "c7dcd7b33bfd6b2951d0c55f6eb1b75dd42497951a88e504f066cbe64563152a",
    severity: "error",
  },
  {
    target: "resolved_segment",
    scope: "coreFrameworkSteps",
    expectedHash: "641eaa00024b466fb2f94b3370495bbbf06d70adeab101201bcc58971fc7ba3c",
    severity: "error",
  },
  {
    target: "resolved_segment",
    scope: "globalStep0Protocol",
    expectedHash: "3854c8b6318ecf9289cf809fb87e05bb9baea25645fd1cbcf1b8faa3c09c8fcd",
    severity: "error",
  },
  {
    target: "resolved_segment",
    scope: "globalStep0Message",
    expectedHash: "8c074ef2557cf1c517f564f04fa49a210b6653021c6b541f9c17592910ad1458",
    severity: "error",
  },
];

// ── Hashing ──────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Compute SHA-256 of an alias map's mappings for integrity verification.
 * Sorts keys to ensure deterministic output regardless of JSON key order.
 */
export function computeAliasMapHash(mappings: Record<string, string>): string {
  const sorted = JSON.stringify(mappings, Object.keys(mappings).sort());
  return sha256(sorted);
}

// ── Alias Map Integrity ──────────────────────────────────────────────

/**
 * Verify an alias map's integrity using two independent checks:
 *
 *   1. Internal consistency: stored `hash` field matches computed SHA-256 of mappings
 *   2. Embedded baseline:   computed SHA-256 matches the hard-coded expected hash
 *
 * Returns true only if BOTH checks pass.
 */
export function verifyAliasMapIntegrity(map: PromptAliasMap): boolean {
  const computed = computeAliasMapHash(map.mappings);
  let ok = true;

  // Check 1: Internal hash consistency
  if (computed !== map.hash) {
    logger.error("Alias map internal hash mismatch — file may be corrupted", {
      event: "alias_map_hash_mismatch",
      locale: map.locale,
      storedHash: map.hash,
      computedHash: computed,
    });
    ok = false;
  }

  // Check 2: Embedded baseline
  const baseline = BASELINES.find(
    (b) => b.target === "alias_map" && b.scope === map.locale,
  );
  if (baseline) {
    if (computed !== baseline.expectedHash) {
      logger.error("Alias map hash does not match embedded baseline — possible tampering", {
        event: "alias_map_baseline_mismatch",
        locale: map.locale,
        expectedHash: baseline.expectedHash,
        computedHash: computed,
      });
      ok = false;
    }
  } else {
    // No baseline for this locale — warn but don't fail
    logger.warn("No embedded baseline for alias map locale", {
      event: "alias_map_no_baseline",
      locale: map.locale,
      computedHash: computed,
    });
  }

  return ok;
}

// ── Prompt Segment Integrity ─────────────────────────────────────────

/**
 * Verify resolved prompt segments against embedded baseline hashes.
 *
 * Only checks segments that have a corresponding `resolved_segment` baseline
 * entry. Segments without a baseline pass through unchecked.
 *
 * @param segments - Resolved prompt segments (aliases already expanded)
 * @returns IntegrityResult with ok=false and a list of failure descriptions
 */
export function verifyPromptIntegrity(
  segments: Record<string, string>,
): IntegrityResult {
  const failures: string[] = [];
  const resolvedBaselines = BASELINES.filter(
    (b) => b.target === "resolved_segment",
  );

  for (const baseline of resolvedBaselines) {
    const segmentValue = segments[baseline.scope];
    if (segmentValue === undefined) {
      failures.push(
        `Segment "${baseline.scope}" is missing from resolved segments`,
      );
      continue;
    }

    const computed = sha256(segmentValue);
    if (computed !== baseline.expectedHash) {
      failures.push(
        `Segment "${baseline.scope}" hash mismatch: expected ${baseline.expectedHash.slice(0, 12)}…, got ${computed.slice(0, 12)}…`,
      );
    }
  }

  if (failures.length > 0) {
    logger.error("Prompt integrity check failed", {
      event: "prompt_integrity_failed",
      failureCount: failures.length,
      failures,
    });
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}
