import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Persona } from "../utils/parser.js";
import {
  type ReviewStepId,
  type ReviewStepKind,
  type BaseReviewStep,
  type InlineStep,
  type OrchestrationTurnStep,
  type ReviewStepContext,
  type ReviewStepResult,
  type PreAuditDimensionResult,
  type PreAuditReport,
  type AuditLlmCaller,
  getFindingsLevel,
  buildEmptyDeltaRisks,
  normalizePreAuditDimensions,
  mergeLocalFindingsIntoAudits,
  computeDeltaAnalysis,
  crossValidateRiskyDimensions,
  finalizePreAuditReport,
  executeFullPipeline,
  stepStripContext,
  stepBareAudit,
  stepFullAudit,
  stepDeltaAnalysis,
  stepMergeLocalFindings,
  stepCrossValidation,
  stepSynergyWeighting,
  stepFinalArbitration,
  orchestrationStep0,
  orchestrationAudit,
  orchestrationFinal,
} from "../execution/reviewSteps.js";

function makePersona(id: string, name: string): Persona {
  return {
    meta: {
      id,
      name,
      name_en: name,
      version: "1.0",
      author: "test",
      tags: [],
      description: `Test auditor ${name}`,
    },
    systemPrompt: "You are a test auditor.",
    filePath: "/tmp/test.json",
  };
}

// ── Type system tests ─────────────────────────────────────────────────────────

describe("ReviewStep type system", () => {
  test("InlineStep interface is correctly typed", () => {
    const step: InlineStep = {
      id: "strip_context",
      kind: "inline",
      async run(_ctx: ReviewStepContext): Promise<ReviewStepResult> {
        return { stepId: "strip_context", output: "test" };
      },
    };
    assert.equal(step.id, "strip_context");
    assert.equal(step.kind, "inline");
    assert.ok(typeof step.run === "function");
  });

  test("OrchestrationTurnStep interface is correctly typed", () => {
    const step: OrchestrationTurnStep = {
      id: "orchestration_step0",
      kind: "orchestration_turn",
      async buildPrompt(_ctx: ReviewStepContext): Promise<string> {
        return "prompt";
      },
      async resume(_ctx: ReviewStepContext, _hostResult: unknown): Promise<ReviewStepResult> {
        return { stepId: "orchestration_step0", output: {} };
      },
    };
    assert.equal(step.id, "orchestration_step0");
    assert.equal(step.kind, "orchestration_turn");
    assert.ok(typeof step.buildPrompt === "function");
    assert.ok(typeof step.resume === "function");
  });

  test("InlineStep constants exist with correct structure", () => {
    assert.equal(stepStripContext.id, "strip_context");
    assert.equal(stepStripContext.kind, "inline");

    assert.equal(stepBareAudit.id, "bare_audit");
    assert.equal(stepBareAudit.kind, "inline");

    assert.equal(stepFullAudit.id, "full_audit");
    assert.equal(stepFullAudit.kind, "inline");

    assert.equal(stepDeltaAnalysis.id, "delta_analysis");
    assert.equal(stepDeltaAnalysis.kind, "inline");

    assert.equal(stepMergeLocalFindings.id, "merge_local_findings");
    assert.equal(stepMergeLocalFindings.kind, "inline");

    assert.equal(stepCrossValidation.id, "cross_validation");
    assert.equal(stepCrossValidation.kind, "inline");

    assert.equal(stepSynergyWeighting.id, "synergy_weighting");
    assert.equal(stepSynergyWeighting.kind, "inline");

    assert.equal(stepFinalArbitration.id, "final_arbitration");
    assert.equal(stepFinalArbitration.kind, "inline");
  });

  test("OrchestrationTurnStep constants exist with correct structure", () => {
    assert.equal(orchestrationStep0.id, "orchestration_step0");
    assert.equal(orchestrationStep0.kind, "orchestration_turn");
    assert.ok(typeof orchestrationStep0.buildPrompt === "function");
    assert.ok(typeof orchestrationStep0.resume === "function");

    assert.equal(orchestrationAudit.id, "orchestration_audit");
    assert.equal(orchestrationAudit.kind, "orchestration_turn");
    assert.ok(typeof orchestrationAudit.buildPrompt === "function");
    assert.ok(typeof orchestrationAudit.resume === "function");

    assert.equal(orchestrationFinal.id, "orchestration_final");
    assert.equal(orchestrationFinal.kind, "orchestration_turn");
    assert.ok(typeof orchestrationFinal.buildPrompt === "function");
    assert.ok(typeof orchestrationFinal.resume === "function");
  });

  test("ReviewStepResult has stepId and output", () => {
    const result: ReviewStepResult = { stepId: "delta_analysis", output: { bareOnly: [] } };
    assert.equal(result.stepId, "delta_analysis");
    assert.deepEqual(result.output, { bareOnly: [] });
  });
});

// ── Pure utility function tests ──────────────────────────────────────────────

describe("getFindingsLevel", () => {
  test("returns 🟢 for empty findings", () => {
    assert.equal(getFindingsLevel([]), "🟢");
  });

  test("returns 🔴 when any finding has 🔴 suggestedLevel", () => {
    const findings = [
      { keyword: "test", suggestedLevel: "🟡" },
      { keyword: "bad", suggestedLevel: "🔴" },
      { keyword: "ok", suggestedLevel: "🟢" },
    ];
    assert.equal(getFindingsLevel(findings), "🔴");
  });

  test("returns 🟡 when max is 🟡", () => {
    const findings = [
      { keyword: "test", suggestedLevel: "🟢" },
      { keyword: "warn", suggestedLevel: "🟡" },
    ];
    assert.equal(getFindingsLevel(findings), "🟡");
  });

  test("returns 🟢 when no suggestedLevel is 🔴 or 🟡", () => {
    const findings = [{ keyword: "test" }, { keyword: "ok" }];
    assert.equal(getFindingsLevel(findings), "🟢");
  });
});

describe("buildEmptyDeltaRisks", () => {
  test("returns empty arrays", () => {
    const result = buildEmptyDeltaRisks();
    assert.deepEqual(result, { bareOnly: [], fullOnly: [], stable: [] });
  });
});

describe("computeDeltaAnalysis", () => {
  test("returns empty delta for empty results", () => {
    const result = computeDeltaAnalysis([], []);
    assert.deepEqual(result, { bareOnly: [], fullOnly: [], stable: [] });
  });

  test("separates bare-only, full-only, and stable risks", () => {
    const bareResults: PreAuditDimensionResult[] = [
      { id: "ctx", name: "Ctx", findings: [{ keyword: "alpha" }, { keyword: "beta" }] },
    ];
    const fullResults: PreAuditDimensionResult[] = [
      { id: "ctx", name: "Ctx", findings: [{ keyword: "beta" }, { keyword: "gamma" }] },
    ];
    const result = computeDeltaAnalysis(bareResults, fullResults);
    assert.ok(result.bareOnly.includes("alpha"));
    assert.ok(result.fullOnly.includes("gamma"));
    assert.ok(result.stable.includes("beta"));
    assert.equal(result.bareOnly.length, 1);
    assert.equal(result.fullOnly.length, 1);
    assert.ok(result.stable.length >= 1);
  });

  test("handles case-insensitive overlap", () => {
    const bareResults: PreAuditDimensionResult[] = [
      { id: "ctx", name: "Ctx", findings: [{ keyword: "Alpha" }] },
    ];
    const fullResults: PreAuditDimensionResult[] = [
      { id: "ctx", name: "Ctx", findings: [{ keyword: "alpha" }] },
    ];
    const result = computeDeltaAnalysis(bareResults, fullResults);
    assert.ok(result.stable.some((k) => k.toLowerCase() === "alpha"));
    assert.equal(result.bareOnly.length, 0);
    assert.equal(result.fullOnly.length, 0);
  });
});

// ── normalizePreAuditDimensions tests ─────────────────────────────────────────

describe("normalizePreAuditDimensions", () => {
  const auditors = [makePersona("legal", "Legal Auditor"), makePersona("social", "Social Auditor")];

  test("normalizes empty input to auditor list with 🟢 level", () => {
    const result = normalizePreAuditDimensions(null, auditors);
    assert.equal(result.length, 2);
    assert.ok(result.every((d) => d.level === "🟢"));
  });

  test("fills missing auditors with 🟢 level", () => {
    const input = [{ id: "legal", name: "Legal", findings: [{ keyword: "x", suggestedLevel: "🟡" }] }];
    const result = normalizePreAuditDimensions(input, auditors);
    assert.equal(result.length, 2);
    const legal = result.find((d) => d.id === "legal");
    assert.equal(legal?.level, "🟡");
    const social = result.find((d) => d.id === "social");
    assert.equal(social?.level, "🟢");
  });

  test("normalizes findings with missing suggestedLevel to 🟡", () => {
    const input = [
      { id: "legal", name: "Legal", findings: [{ keyword: "x" } as unknown as Record<string, unknown>] },
    ];
    const result = normalizePreAuditDimensions(input, auditors);
    assert.equal(result[0].findings[0].suggestedLevel, "🟡");
  });
});

// ── mergeLocalFindingsIntoAudits tests ────────────────────────────────────────

describe("mergeLocalFindingsIntoAudits", () => {
  const networkCulture: PreAuditDimensionResult = {
    id: "network_culture_risk",
    name: "Network Culture",
    findings: [],
  };

  test("returns audits unchanged when localFindings is empty", () => {
    const result = mergeLocalFindingsIntoAudits([networkCulture], []);
    assert.equal(result.length, 1);
    assert.equal(result[0].findings.length, 0);
  });

  test("merges local findings into network_culture_risk when it exists", () => {
    const local = [{ keyword: "dark", suggestedLevel: "🔴" }];
    const result = mergeLocalFindingsIntoAudits([{ ...networkCulture }], local);
    const nc = result.find((a) => a.id === "network_culture_risk");
    assert.equal(nc?.findings.length, 1);
    assert.equal(nc?.findings[0].keyword, "dark");
    assert.equal(nc?.level, "🔴");
  });

  test("creates local_rule_engine entry when network_culture_risk is absent", () => {
    const otherAudit: PreAuditDimensionResult = { id: "legal", name: "Legal", findings: [] };
    const local = [{ keyword: "hit", suggestedLevel: "🟡" }];
    const result = mergeLocalFindingsIntoAudits([otherAudit], local);
    const lre = result.find((a) => a.id === "local_rule_engine");
    assert.ok(lre);
    assert.equal(lre?.findings.length, 1);
  });
});

// ── OrchestrationTurnStep resume tests ────────────────────────────────────────

describe("orchestrationStep0.resume", () => {
  test("parses step0Result and webContextMap from host result", async () => {
    const ctx: ReviewStepContext = {
      content: "test",
      systemAuditors: [],
      localFindings: [],
    };
    const hostResult = {
      blackAtoms: [{ keyword: "atom1" }],
      attackCandidates: [{ keyword: "attack1" }],
      wildTranslations: [{ original: "hello", wildTranslation: "world" }],
      precedents: [{ event: "past event", date: "2024" }],
      webContextMap: { keyword1: "context string" },
    };
    const result = await orchestrationStep0.resume(ctx, hostResult);
    assert.equal(result.stepId, "orchestration_step0");
    assert.ok(result.output.step0Result);
    assert.equal(result.output.step0Result.blackAtoms.length, 1);
    assert.equal(result.output.step0Result.precedents.length, 1);
    assert.equal(result.output.webContextMap.keyword1, "context string");
  });

  test("filters non-string values from webContextMap", async () => {
    const ctx: ReviewStepContext = {
      content: "test",
      systemAuditors: [],
      localFindings: [],
    };
    const hostResult = {
      blackAtoms: [],
      attackCandidates: [],
      webContextMap: { valid: "ok", invalid: 123, alsoInvalid: null },
    };
    const result = await orchestrationStep0.resume(ctx, hostResult);
    assert.equal(Object.keys(result.output.webContextMap).length, 1);
    assert.equal(result.output.webContextMap.valid, "ok");
  });
});

describe("orchestrationAudit.resume", () => {
  test("parses dimensions and deltaRisks from host result", async () => {
    const ctx: ReviewStepContext = {
      content: "test",
      systemAuditors: [],
      localFindings: [],
    };
    const hostResult = {
      dimensions: [{ id: "legal", findings: [{ keyword: "x" }] }],
      deltaRisks: { bareOnly: ["x"], fullOnly: [], stable: [] },
    };
    const result = await orchestrationAudit.resume(ctx, hostResult);
    assert.equal(result.stepId, "orchestration_audit");
    assert.equal(result.output.dimensions.length, 1);
    assert.equal(result.output.deltaRisks.bareOnly[0], "x");
  });

  test("defaults deltaRisks when missing", async () => {
    const ctx: ReviewStepContext = {
      content: "test",
      systemAuditors: [],
      localFindings: [],
    };
    const result = await orchestrationAudit.resume(ctx, { dimensions: [] });
    assert.deepEqual(result.output.deltaRisks, { bareOnly: [], fullOnly: [], stable: [] });
  });
});

describe("orchestrationFinal.resume", () => {
  test("parses final report from host result", async () => {
    const ctx: ReviewStepContext = {
      content: "test",
      systemAuditors: [],
      localFindings: [],
    };
    const hostResult = {
      dimensions: [{ id: "legal", findings: [{ keyword: "x" }] }],
      summary: "Test summary",
      worstCaseNarrative: "Worst case",
    };
    const result = await orchestrationFinal.resume(ctx, hostResult);
    assert.equal(result.stepId, "orchestration_final");
    assert.equal(result.output.dimensions.length, 1);
    assert.equal(result.output.summary, "Test summary");
    assert.equal(result.output.worstCaseNarrative, "Worst case");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8.2: Cross-validation LLM failure → skip pair (P1-3)
// ─────────────────────────────────────────────────────────────────────────────

describe("crossValidateRiskyDimensions — LLM failure handling", () => {
  test("skips a pair when samplingFn throws, continues others", async () => {
    const auditors = [
      makePersona("network_culture_risk", "暗语破译"),
      makePersona("context_distortion", "语境猎手"),
    ];

    // Failing samplingFn: throws on first call, succeeds on subsequent
    let callCount = 0;
    const samplingFn: AuditLlmCaller = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("LLM timeout");
      }
      return {
        content: JSON.stringify({
          findings: [{ keyword: "ok", status: "confirmed", reason: "looks fine" }],
        }),
      };
    };

    const phase1Results: PreAuditDimensionResult[] = [
      { id: "network_culture_risk", name: "暗语破译", findings: [{ keyword: "bad" }], level: "🟡" },
      { id: "context_distortion", name: "语境猎手", findings: [{ keyword: "risky" }], level: "🟡" },
    ];

    const result = await crossValidateRiskyDimensions(
      "test content",
      phase1Results,
      auditors,
      samplingFn,
    );

    // Should not throw; both pairs attempted
    assert.ok(result.length >= 2);
    assert.ok(callCount >= 2, "should have attempted multiple pairs");
  });

  test("returns phase1Results unchanged when no risky dimensions", async () => {
    const auditors = [makePersona("legal_compliance", "合规哨兵")];
    const samplingFn: AuditLlmCaller = async () => {
      throw new Error("should not be called");
    };

    const phase1Results: PreAuditDimensionResult[] = [
      { id: "legal_compliance", name: "合规哨兵", findings: [], level: "🟢" },
    ];

    const result = await crossValidateRiskyDimensions(
      "test",
      phase1Results,
      auditors,
      samplingFn,
    );

    assert.deepEqual(result, phase1Results);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8.2: Final arbitration LLM failure → fallback summary (P1-4)
// ─────────────────────────────────────────────────────────────────────────────

describe("finalizePreAuditReport — LLM failure fallback", () => {
  test("returns deterministic summary when caller throws", async () => {
    const caller: AuditLlmCaller = async () => {
      throw new Error("LLM API error");
    };

    const auditors = [
      makePersona("social_risk", "社伦判官"),
    ];

    const crossValidated: PreAuditDimensionResult[] = [
      { id: "social_risk", name: "社伦判官", findings: [{ keyword: "risky", suggestedLevel: "🟡" }], level: "🟡" },
    ];

    const synergy = {
      triggered: ["测试协同"],
      overallMultiplier: 2.0,
      levelUpgrades: [{ dimension: "social_risk", from: "🟡", to: "🔴", reason: "test" }],
    };

    const report = await finalizePreAuditReport(
      "test content",
      [],
      crossValidated,
      crossValidated,
      auditors,
      caller,
      synergy,
    );

    // Still produces a valid report via summarizeFallback
    assert.ok(typeof report.summary === "string");
    assert.ok(report.summary.length > 0);
    assert.ok(report.dimensions.length > 0);

    // Synergy level upgrades still applied
    const dim = report.dimensions.find((d: any) => d.id === "social_risk");
    assert.ok(dim);
    assert.equal(dim.level, "🔴");
  });

  test("returns default summary when all dimensions pass", async () => {
    const caller: AuditLlmCaller = async () => {
      throw new Error("LLM down");
    };

    const auditors = [makePersona("legal_compliance", "合规哨兵")];
    const crossValidated: PreAuditDimensionResult[] = [
      { id: "legal_compliance", name: "合规哨兵", findings: [], level: "🟢" },
    ];

    const report = await finalizePreAuditReport(
      "test",
      [],
      crossValidated,
      crossValidated,
      auditors,
      caller,
    );

    assert.equal(report.summary, "全部维度通过");
    assert.equal(report.dimensions.length, 1);
    assert.equal(report.dimensions[0].level, "🟢");
  });
});
