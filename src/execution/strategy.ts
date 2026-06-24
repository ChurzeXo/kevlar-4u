import { createHash } from "node:crypto";

export type Entitlement = "free" | "pro";

export type ReviewStepId =
  | "local_rules"
  | "orchestration_step0"
  | "strip_context"
  | "bare_audit"
  | "full_audit"
  | "delta_analysis"
  | "merge_local_findings"
  | "cross_validation"
  | "synergy_weighting"
  | "final_arbitration"
  | "display"
  | "rst_review";

export type VisibilityPolicy = {
  preAuditDetails: "hidden" | "full";
  upgradePrompt: "after_rst" | "disabled";
  rstContinuationPrompt?: "after_pre_audit";
};

export interface ReviewPlan {
  tier: Entitlement;
  steps: string[];
  visibility: VisibilityPolicy;
  /** Immutable strategy identity — set by StrategyProvider on resolution. */
  strategySessionId: string;
  strategyVersion: string;
  strategyHash: string;
}

export interface StrategyContext {
  locale: "zh-CN" | "en-US";
}

export interface SynergyWeights {
  rules: Array<{ id: string; weight: number }>;
}

export function computePlanFingerprint(tier: string, steps: string[]): string {
  return createHash("sha256")
    .update(`kevlar-plan-${tier}-${steps.join(",")}-v1`)
    .digest("hex")
    .slice(0, 16);
}

export interface StrategyProvider {
  getEntitlement(ctx?: StrategyContext): Promise<Entitlement>;
  getReviewPlan(ctx?: StrategyContext): Promise<ReviewPlan>;
  getPromptTemplate?(id: string, ctx?: StrategyContext): Promise<string | null>;
  getWeights?(ctx?: StrategyContext): Promise<SynergyWeights>;
  getVisibilityPolicy?(ctx?: StrategyContext): Promise<ReviewPlan["visibility"]>;
  /** Returns bundle-delivered synergy rules, or undefined to use hardcoded defaults. */
  getSynergyRules?(): Array<{
    dimensions: string[];
    condition: "ALL" | "ANY";
    multiplier: number;
    upgradeLevel: boolean;
    label: string;
  }>;
}

const FREE_PLAN: ReviewPlan = {
  tier: "free",
  steps: ["rst_review"],
  visibility: {
    preAuditDetails: "hidden",
    upgradePrompt: "after_rst",
  },
  strategySessionId: "free-builtin-v1",
  strategyVersion: "1.0.0",
  strategyHash: computePlanFingerprint("free", ["rst_review"]),
};

const PRO_PLAN: ReviewPlan = {
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
  strategySessionId: "pro-inmemory-v1",
  strategyVersion: "1.0.0",
  strategyHash: computePlanFingerprint("pro", [
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
  ]),
};

export class FreeStrategyProvider implements StrategyProvider {
  async getEntitlement(): Promise<Entitlement> {
    return "free";
  }

  async getReviewPlan(): Promise<ReviewPlan> {
    return FREE_PLAN;
  }
}

export class InMemoryProStrategyProvider implements StrategyProvider {
  async getEntitlement(): Promise<Entitlement> {
    return "pro";
  }

  async getReviewPlan(): Promise<ReviewPlan> {
    return PRO_PLAN;
  }

  async getPromptTemplate(_id: string): Promise<string | null> {
    return null;
  }

  async getWeights(): Promise<SynergyWeights> {
    return { rules: [] };
  }

  async getVisibilityPolicy(): Promise<ReviewPlan["visibility"]> {
    return PRO_PLAN.visibility;
  }
}
