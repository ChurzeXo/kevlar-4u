import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  setObservationCacheDir,
  recordHostStructuredObservation,
  recordCapabilityObservation,
  getHostStructuredObservation,
  listObservations,
  clearObservations,
  inferTaskClass,
} from "../execution/observations.js";
import type {
  ClientFingerprint,
  TaskClass,
  StructuredObservationKey,
  HostStructuredObservation,
} from "../execution/plan.js";

let tmpDir: string;
let origForceEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-obs-test-"));
  setObservationCacheDir(tmpDir);
  origForceEnv = process.env.KEVLAR_FORCE_HOST_STRUCTURED;
  delete process.env.KEVLAR_FORCE_HOST_STRUCTURED;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origForceEnv !== undefined) {
    process.env.KEVLAR_FORCE_HOST_STRUCTURED = origForceEnv;
  } else {
    delete process.env.KEVLAR_FORCE_HOST_STRUCTURED;
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const FP_A: ClientFingerprint = { name: "Claude", version: "1.0", transport: "stdio" };
const FP_B: ClientFingerprint = { name: "Cursor", version: "0.5", transport: "stdio" };

function makeKey(
  fp: ClientFingerprint,
  taskClass: TaskClass = "short",
  opts?: { model?: string; locale?: string },
): StructuredObservationKey {
  return {
    fingerprint: fp,
    model: opts?.model,
    protocolVersion: "kevlar-host-guided/v1",
    taskClass,
    locale: opts?.locale,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// inferTaskClass
// ─────────────────────────────────────────────────────────────────────────────

describe("inferTaskClass", () => {
  it("returns 'short' for empty/undefined content", () => {
    assert.equal(inferTaskClass(undefined), "short");
    assert.equal(inferTaskClass(""), "short");
  });

  it("returns 'short' for content < 800 chars", () => {
    assert.equal(inferTaskClass("a".repeat(100)), "short");
    assert.equal(inferTaskClass("a".repeat(799)), "short");
  });

  it("returns 'medium' for 800-2999 chars", () => {
    assert.equal(inferTaskClass("a".repeat(800)), "medium");
    assert.equal(inferTaskClass("a".repeat(2999)), "medium");
  });

  it("returns 'long' for >= 3000 chars", () => {
    assert.equal(inferTaskClass("a".repeat(3000)), "long");
    assert.equal(inferTaskClass("a".repeat(10000)), "long");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic Record + Lookup
// ─────────────────────────────────────────────────────────────────────────────

describe("recordHostStructuredObservation + getHostStructuredObservation", () => {
  it("returns undefined when cache is empty", () => {
    const result = getHostStructuredObservation(makeKey(FP_A));
    assert.equal(result, undefined);
  });

  it("round-trips a positive observation", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    const result = getHostStructuredObservation(makeKey(FP_A));
    assert.ok(result);
    assert.equal(result!.status, "format_verified");
    assert.equal(result!.reason, "kevlar_result_schema_matched");
    assert.ok(result!.observedAt > 0);
    assert.ok(result!.expiresAt > result!.observedAt);
  });

  it("round-trips a negative observation", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A, "medium"),
      status: "unsupported",
      reason: "host_rejected",
    });

    const result = getHostStructuredObservation(makeKey(FP_A, "medium"));
    assert.ok(result);
    assert.equal(result!.status, "unsupported");
    assert.equal(result!.reason, "host_rejected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TTL Expiry
// ─────────────────────────────────────────────────────────────────────────────

describe("TTL expiry", () => {
  it("does not return expired observations", () => {
    // Record an observation with 1h TTL (likely_output_truncated)
    recordHostStructuredObservation({
      key: makeKey(FP_A),
      status: "failed",
      reason: "likely_output_truncated",
    });

    // Manually backdate the observation in the cache file
    const cachePath = path.join(tmpDir, "kevlar-observations.json");
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    raw.observations[0].expiresAt = Date.now() - 1000; // expired 1s ago
    fs.writeFileSync(cachePath, JSON.stringify(raw));

    const result = getHostStructuredObservation(makeKey(FP_A));
    assert.equal(result, undefined);
  });

  it("format_verified has 7-day TTL", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    const cachePath = path.join(tmpDir, "kevlar-observations.json");
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    const obs = raw.observations[0];
    const ttl = obs.expiresAt - obs.observedAt;
    assert.equal(ttl, 7 * 24 * 60 * 60 * 1000);
  });

  it("unsupported has 24h TTL", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A),
      status: "unsupported",
      reason: "host_rejected",
    });

    const cachePath = path.join(tmpDir, "kevlar-observations.json");
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    const obs = raw.observations[0];
    const ttl = obs.expiresAt - obs.observedAt;
    assert.equal(ttl, 24 * 60 * 60 * 1000);
  });

  it("likely_output_truncated has 1h TTL", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A),
      status: "failed",
      reason: "likely_output_truncated",
    });

    const cachePath = path.join(tmpDir, "kevlar-observations.json");
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    const obs = raw.observations[0];
    const ttl = obs.expiresAt - obs.observedAt;
    assert.equal(ttl, 1 * 60 * 60 * 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint Matching
// ─────────────────────────────────────────────────────────────────────────────

describe("fingerprint matching", () => {
  it("does not match different fingerprints", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    const result = getHostStructuredObservation(makeKey(FP_B));
    assert.equal(result, undefined);
  });

  it("does not match different protocol versions", () => {
    recordHostStructuredObservation({
      key: { ...makeKey(FP_A), protocolVersion: "kevlar-host-guided/v1" },
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    const result = getHostStructuredObservation({
      ...makeKey(FP_A),
      protocolVersion: "kevlar-host-guided/v2" as any,
    });
    assert.equal(result, undefined);
  });

  it("does not match when models differ", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A, "short", { model: "gpt-4" }),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    const result = getHostStructuredObservation(makeKey(FP_A, "short", { model: "claude-3" }));
    assert.equal(result, undefined);
  });

  it("matches when model is absent in both", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A), // no model
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    const result = getHostStructuredObservation(makeKey(FP_A)); // no model
    assert.ok(result);
    assert.equal(result!.status, "format_verified");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TaskClass Fuzzy Matching
// ─────────────────────────────────────────────────────────────────────────────

describe("taskClass matching", () => {
  it("exact match: short matches short", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A, "short"),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    const result = getHostStructuredObservation(makeKey(FP_A, "short"));
    assert.ok(result);
    assert.equal(result!.status, "format_verified");
  });

  it("heavier task observation satisfies lighter query (long → medium)", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A, "long"),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    const result = getHostStructuredObservation(makeKey(FP_A, "medium"));
    assert.ok(result);
    assert.equal(result!.status, "format_verified");
  });

  it("heavier task observation satisfies lighter query (long → short)", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A, "long"),
      status: "unsupported",
      reason: "host_rejected",
    });

    const result = getHostStructuredObservation(makeKey(FP_A, "short"));
    assert.ok(result);
    assert.equal(result!.status, "unsupported");
  });

  it("lighter task observation does NOT satisfy heavier query (short ↛ long)", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A, "short"),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    const result = getHostStructuredObservation(makeKey(FP_A, "long"));
    assert.equal(result, undefined);
  });

  it("prefers exact match over lighter match", () => {
    // Record both a short (lighter) and a medium (exact) observation
    recordHostStructuredObservation({
      key: makeKey(FP_A, "short"),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });
    recordHostStructuredObservation({
      key: makeKey(FP_A, "medium"),
      status: "unsupported",
      reason: "host_rejected",
    });

    // Query for medium → should get the exact medium match (unsupported), not the lighter short one
    const result = getHostStructuredObservation(makeKey(FP_A, "medium"));
    assert.ok(result);
    assert.equal(result!.status, "unsupported");
    assert.equal(result!.reason, "host_rejected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KEVLAR_FORCE_HOST_STRUCTURED bypass
// ─────────────────────────────────────────────────────────────────────────────

describe("KEVLAR_FORCE_HOST_STRUCTURED bypass", () => {
  it("getHostStructuredObservation returns undefined when env is set", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    process.env.KEVLAR_FORCE_HOST_STRUCTURED = "true";

    const result = getHostStructuredObservation(makeKey(FP_A));
    assert.equal(result, undefined);
  });

  it("recordHostStructuredObservation does not persist when env is set", () => {
    process.env.KEVLAR_FORCE_HOST_STRUCTURED = "true";

    recordHostStructuredObservation({
      key: makeKey(FP_A),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    // Remove env and check — cache should still be empty
    delete process.env.KEVLAR_FORCE_HOST_STRUCTURED;
    const result = getHostStructuredObservation(makeKey(FP_A));
    assert.equal(result, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recordCapabilityObservation convenience wrapper
// ─────────────────────────────────────────────────────────────────────────────

describe("recordCapabilityObservation", () => {
  it("creates a properly keyed observation", () => {
    recordCapabilityObservation(
      FP_A,
      "medium",
      "format_verified",
      "kevlar_result_schema_matched",
      { model: "gpt-4", locale: "zh-CN" },
    );

    const result = getHostStructuredObservation(
      makeKey(FP_A, "medium", { model: "gpt-4", locale: "zh-CN" }),
    );
    assert.ok(result);
    assert.equal(result!.status, "format_verified");
  });

  it("records negative observation", () => {
    recordCapabilityObservation(
      FP_B,
      "long",
      "unsupported",
      "host_rejected",
    );

    const result = getHostStructuredObservation(makeKey(FP_B, "long"));
    assert.ok(result);
    assert.equal(result!.status, "unsupported");
    assert.equal(result!.reason, "host_rejected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listObservations + clearObservations
// ─────────────────────────────────────────────────────────────────────────────

describe("listObservations + clearObservations", () => {
  it("listObservations returns all non-expired entries", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A, "short"),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });
    recordHostStructuredObservation({
      key: makeKey(FP_B, "long"),
      status: "unsupported",
      reason: "host_rejected",
    });

    const all = listObservations();
    assert.equal(all.length, 2);
  });

  it("clearObservations removes all entries", () => {
    recordHostStructuredObservation({
      key: makeKey(FP_A),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    clearObservations();

    const all = listObservations();
    assert.equal(all.length, 0);

    const result = getHostStructuredObservation(makeKey(FP_A));
    assert.equal(result, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Purge on record (same fingerprint, different version)
// ─────────────────────────────────────────────────────────────────────────────

describe("purge on record", () => {
  it("purges old version entries for same fingerprint when recording new version", () => {
    const fpV1: ClientFingerprint = { name: "Claude", version: "1.0", transport: "stdio" };
    const fpV2: ClientFingerprint = { name: "Claude", version: "2.0", transport: "stdio" };

    recordHostStructuredObservation({
      key: makeKey(fpV1),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    // Record new version — old one should be purged
    recordHostStructuredObservation({
      key: makeKey(fpV2),
      status: "format_verified",
      reason: "kevlar_result_schema_matched",
    });

    // Old version should not be found
    const oldResult = getHostStructuredObservation(makeKey(fpV1));
    assert.equal(oldResult, undefined);

    // New version should be found
    const newResult = getHostStructuredObservation(makeKey(fpV2));
    assert.ok(newResult);
  });
});
