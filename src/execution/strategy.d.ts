export type Entitlement = "free" | "pro";
export type ReviewStepId = "local_rules" | "orchestration_step0" | "strip_context" | "bare_audit" | "full_audit" | "delta_analysis" | "merge_local_findings" | "cross_validation" | "synergy_weighting" | "final_arbitration" | "display" | "rst_review";
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
    rules: Array<{
        id: string;
        weight: number;
    }>;
}
export declare function computePlanFingerprint(tier: string, steps: string[]): string;
export interface StrategyProvider {
    getEntitlement(ctx?: StrategyContext): Promise<Entitlement>;
    getReviewPlan(ctx?: StrategyContext): Promise<ReviewPlan>;
    getPromptTemplate?(id: string, ctx?: StrategyContext): Promise<string | null>;
    getWeights?(ctx?: StrategyContext): Promise<SynergyWeights>;
    getVisibilityPolicy?(ctx?: StrategyContext): Promise<ReviewPlan["visibility"]>;
}
export declare class FreeStrategyProvider implements StrategyProvider {
    getEntitlement(): Promise<Entitlement>;
    getReviewPlan(): Promise<ReviewPlan>;
}
export declare class InMemoryProStrategyProvider implements StrategyProvider {
    getEntitlement(): Promise<Entitlement>;
    getReviewPlan(): Promise<ReviewPlan>;
    getPromptTemplate(_id: string): Promise<string | null>;
    getWeights(): Promise<SynergyWeights>;
    getVisibilityPolicy(): Promise<ReviewPlan["visibility"]>;
}
//# sourceMappingURL=strategy.d.ts.map