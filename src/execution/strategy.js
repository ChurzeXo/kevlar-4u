import { createHash } from "node:crypto";
export function computePlanFingerprint(tier, steps) {
    return createHash("sha256")
        .update(`kevlar-plan-${tier}-${steps.join(",")}-v1`)
        .digest("hex")
        .slice(0, 16);
}
const FREE_PLAN = {
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
const PRO_PLAN = {
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
export class FreeStrategyProvider {
    async getEntitlement() {
        return "free";
    }
    async getReviewPlan() {
        return FREE_PLAN;
    }
}
export class InMemoryProStrategyProvider {
    async getEntitlement() {
        return "pro";
    }
    async getReviewPlan() {
        return PRO_PLAN;
    }
    async getPromptTemplate(_id) {
        return null;
    }
    async getWeights() {
        return { rules: [] };
    }
    async getVisibilityPolicy() {
        return PRO_PLAN.visibility;
    }
}
//# sourceMappingURL=strategy.js.map