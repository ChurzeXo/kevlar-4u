import type { StrategyProvider, Entitlement, ReviewPlan, SynergyWeights } from "./strategy.js";
import type { StrategyBundleV1 } from "./strategyBundle.js";
import { resolveAllTemplates, computePlanFingerprintFromBundle, isBundleExpired, verifyBundleIntegrity } from "./strategyBundle.js";
import { logger } from "../utils/observability.js";

export class BundleStrategyProvider implements StrategyProvider {
  constructor(
    private bundle: StrategyBundleV1,
    private promptVars?: Record<string, string>,
  ) {}

  async getEntitlement(): Promise<Entitlement> {
    const { expired, withinGrace } = isBundleExpired(this.bundle);
    if (expired && !withinGrace) return "free";
    if (expired && withinGrace) {
      logger.warn("Strategy bundle expired, within grace period", {
        event: "bundle_grace_period",
        bundleId: this.bundle.bundleId,
      });
    }
    return "pro";
  }

  async getReviewPlan(): Promise<ReviewPlan> {
    return {
      tier: "pro",
      steps: [...this.bundle.steps],
      visibility: { ...this.bundle.visibility },
      strategySessionId: this.bundle.strategySessionId,
      strategyVersion: this.bundle.version,
      strategyHash: computePlanFingerprintFromBundle(this.bundle),
    };
  }

  async getPromptTemplate(id: string): Promise<string | null> {
    const tmpl = this.bundle.templates[id];
    if (!tmpl) return null;
    return resolveAllTemplates({ [id]: tmpl }, this.promptVars)[id];
  }

  async getWeights(): Promise<SynergyWeights> {
    return {
      rules: this.bundle.synergyRules.map((r, i) => ({
        id: r.label || `synergy_rule_${i}`,
        weight: r.multiplier,
      })),
    };
  }

  async getVisibilityPolicy(): Promise<ReviewPlan["visibility"]> {
    return { ...this.bundle.visibility };
  }

  getBundle(): StrategyBundleV1 {
    return this.bundle;
  }
}

export type BundleLoadResult =
  | { ok: true; provider: BundleStrategyProvider }
  | { ok: false; reason: string };

export function verifyAndCreateProvider(
  bundle: StrategyBundleV1,
  promptVars?: Record<string, string>,
): BundleLoadResult {
  if (bundle.formatVersion !== "kevlar-strategy-bundle-v1") {
    return { ok: false, reason: `Unsupported format: ${bundle.formatVersion}` };
  }
  if (!verifyBundleIntegrity(bundle)) {
    return { ok: false, reason: "Bundle signature mismatch" };
  }
  if (bundle.tier !== "pro") {
    return { ok: false, reason: `Expected pro tier, got ${bundle.tier}` };
  }
  const { expired, withinGrace } = isBundleExpired(bundle);
  if (expired && !withinGrace) {
    return { ok: false, reason: "Bundle expired beyond grace period" };
  }
  const provider = new BundleStrategyProvider(bundle, promptVars);
  return { ok: true, provider };
}
