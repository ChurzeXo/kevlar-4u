import { createHash, createHmac, createVerify, createSign } from "node:crypto";
import type { VisibilityPolicy, SynergyWeights } from "../execution/strategy.js";

/** Ed25519 public key embedded in the client. Corresponding private key on server. */
export const KEVLAR_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA4Rm1xicSuZiuRujvT+DuAbU4D43R7ORzujB0sIAk/ns=
-----END PUBLIC KEY-----`;

/** Shared HMAC key for v1 bundle signing (matches server). Override via KEVLAR_BUNDLE_SIGNING_SECRET env var. */
const BUNDLE_HMAC_KEY = process.env.KEVLAR_BUNDLE_SIGNING_SECRET ?? "kevlar-bundle-signing-dev";

export const STRATEGY_BUNDLE_FORMAT = "kevlar-strategy-bundle-v1";

export interface StrategyBundleV1 {
  formatVersion: typeof STRATEGY_BUNDLE_FORMAT;
  bundleId: string;
  version: string;
  tier: "pro";
  steps: string[];
  visibility: {
    preAuditDetails: "hidden" | "full";
    rstContinuationPrompt?: "after_pre_audit";
    upgradePrompt: "disabled" | "after_rst";
  };
  templates: Record<string, string>;
  dimensionMultipliers: Record<string, number>;
  synergyRules: Array<{
    dimensions: string[];
    condition: "ALL" | "ANY";
    multiplier: number;
    upgradeLevel: boolean;
    label: string;
  }>;
  strategySessionId: string;
  strategyHash: string;
  issuedAt: string;
  expiresAt: string;
  gracePeriodHours: number;
  graceExpiresAt: string;
  watermarkToken: string;
  canaryToken: string;
  sessionNonce: string;
  bundleSignature: string;
}

export function computeBundleHash(data: Omit<StrategyBundleV1, "bundleSignature">): string {
  return createHash("sha256")
    .update(canonicalJSONDeep(data as any))
    .digest("hex");
}

export function canonicalJSON(data: Record<string, unknown>): string {
  return JSON.stringify(data, Object.keys(data).sort());
}

/** Deep canonical JSON: recursively sorts keys at all nesting levels. Used for self-hash and Ed25519. */
export function canonicalJSONDeep(data: Record<string, unknown>): string {
  return JSON.stringify(data, (_key, value) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce(
        (acc, k) => { (acc as Record<string, unknown>)[k] = (value as Record<string, unknown>)[k]; return acc; },
        {} as Record<string, unknown>,
      );
    }
    return value;
  });
}

export function verifyBundleIntegrity(bundle: StrategyBundleV1): boolean {
  const { bundleSignature, ...data } = bundle;

  if (bundle.bundleId === "default") {
    const { strategyHash: _sh, ...defaultData } = data;
    return computeBundleHash(defaultData as any) === bundleSignature;
  }

  // HMAC (deep canonical, original strategyHash)
  try {
    const deep = canonicalJSONDeep(data as any);
    const expected = createHmac("sha256", BUNDLE_HMAC_KEY)
      .update(deep)
      .digest("base64");
    if (expected === bundleSignature) return true;
  } catch { /* fall through */ }

  // Ed25519 (try deep + array-replacer, with original & zeroed strategyHash)
  for (const fn of [canonicalJSONDeep, canonicalJSON]) {
    for (const d of [data, { ...data, strategyHash: "" }]) {
      try {
        const verifier = createVerify("ed25519");
        verifier.update(fn(d as any));
        verifier.end();
        if (verifier.verify(KEVLAR_ED25519_PUBLIC_KEY, bundleSignature, "base64")) return true;
      } catch { /* fall through */ }
    }
  }
  return false;
}

/** Server-side: signs a bundle with the Ed25519 private key from env `KEVLAR_SIGNING_KEY`. */
export function signBundle(
  bundle: StrategyBundleV1,
  privateKeyPem?: string,
): StrategyBundleV1 {
  const key = privateKeyPem ?? process.env.KEVLAR_SIGNING_KEY;
  if (!key) {
    throw new Error("KEVLAR_SIGNING_KEY not set");
  }
  const { bundleSignature: _sig, ...data } = bundle;
  const signer = createSign("ed25519");
  signer.update(canonicalJSON(data as any));
  signer.end();
  bundle.bundleSignature = signer.sign(key, "base64");
  return bundle;
}

export function isBundleExpired(bundle: StrategyBundleV1, now: Date = new Date()): { expired: boolean; withinGrace: boolean } {
  const expiresAt = new Date(bundle.expiresAt);
  const graceExpiresAt = new Date(bundle.graceExpiresAt);
  const nowMs = now.getTime();
  if (nowMs < expiresAt.getTime()) return { expired: false, withinGrace: false };
  if (nowMs < graceExpiresAt.getTime()) return { expired: true, withinGrace: true };
  return { expired: true, withinGrace: false };
}

export function computePlanFingerprintFromBundle(bundle: StrategyBundleV1): string {
  return createHash("sha256")
    .update(`kevlar-plan-${bundle.tier}-${bundle.steps.join(",")}-${bundle.bundleId}`)
    .digest("hex")
    .slice(0, 16);
}

export function resolveTemplateVars(tmpl: string, vars?: Record<string, string>): string {
  if (!vars) return tmpl;
  let result = tmpl;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

export function resolveAllTemplates(templates: Record<string, string>, vars?: Record<string, string>): Record<string, string> {
  if (!vars) return { ...templates };
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(templates)) {
    result[key] = resolveTemplateVars(value, vars);
  }
  return result;
}

export function makeDefaultProBundle(overrides?: Partial<StrategyBundleV1>): StrategyBundleV1 {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const graceExpiresAt = new Date(expiresAt.getTime() + 14 * 24 * 60 * 60 * 1000);
  const bundle: StrategyBundleV1 = {
    formatVersion: STRATEGY_BUNDLE_FORMAT,
    bundleId: "default",
    version: "1.0.0",
    tier: "pro",
    steps: [
      "local_rules",
      "orchestration_step0",
      "strip_context",
      "bare_audit",
      "full_audit",
      "delta_analysis",
      "merge_local_findings",
      "cross_validation",
      "synergy_weighting",
      "final_arbitration",
      "display",
    ],
    visibility: {
      preAuditDetails: "full",
      rstContinuationPrompt: "after_pre_audit",
      upgradePrompt: "disabled",
    },
    templates: {},
    dimensionMultipliers: {},
    synergyRules: [],
    strategySessionId: `default-${now.getTime()}`,
    strategyHash: "",
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    gracePeriodHours: 336,
    graceExpiresAt: graceExpiresAt.toISOString(),
    watermarkToken: "default-watermark",
    canaryToken: "default-canary",
    sessionNonce: "default-nonce",
    bundleSignature: "",
  };
  if (overrides) {
    Object.assign(bundle, overrides);
  }
  const { bundleSignature: _, strategyHash: _sh, ...hashData } = bundle;
  const hash = computeBundleHash(hashData as any);
  bundle.strategyHash = hash.slice(0, 16);
  bundle.bundleSignature = hash;
  return bundle;
}
