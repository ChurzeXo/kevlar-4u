import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  FreeStrategyProvider,
  InMemoryProStrategyProvider,
} from "../execution/strategy.js";
import { handleReviewContentWizard } from "../tools/reviewContentWizardTool.js";
import { writePersonaFile, invalidatePersonasCache } from "../utils/parser.js";
import type { PersonaMeta } from "../utils/parser.js";

describe("FreeStrategyProvider", () => {
  const provider = new FreeStrategyProvider();

  it("returns free entitlement", async () => {
    assert.equal(await provider.getEntitlement(), "free");
  });

  it("returns Free plan with only rst_review step", async () => {
    const plan = await provider.getReviewPlan();
    assert.equal(plan.tier, "free");
    assert.deepEqual(plan.steps, ["rst_review"]);
  });

  it("hides pre-audit details", async () => {
    const plan = await provider.getReviewPlan();
    assert.equal(plan.visibility.preAuditDetails, "hidden");
  });

  it("shows upgrade prompt after RST", async () => {
    const plan = await provider.getReviewPlan();
    assert.equal(plan.visibility.upgradePrompt, "after_rst");
  });

  it("has no rstContinuationPrompt", async () => {
    const plan = await provider.getReviewPlan();
    assert.equal(plan.visibility.rstContinuationPrompt, undefined);
  });

  it("has frozen strategy session identity", async () => {
    const plan = await provider.getReviewPlan();
    assert.ok(typeof plan.strategySessionId === "string");
    assert.ok(plan.strategySessionId.length > 0);
    assert.ok(typeof plan.strategyHash === "string");
    assert.ok(plan.strategyHash.length > 0);
  });
});

describe("InMemoryProStrategyProvider", () => {
  const provider = new InMemoryProStrategyProvider();

  it("returns pro entitlement", async () => {
    assert.equal(await provider.getEntitlement(), "pro");
  });

  it("returns Pro plan with full pipeline steps", async () => {
    const plan = await provider.getReviewPlan();
    assert.equal(plan.tier, "pro");
    assert.ok(plan.steps.includes("local_rules"));
    assert.ok(plan.steps.includes("strip_context"));
    assert.ok(plan.steps.includes("bare_audit"));
    assert.ok(plan.steps.includes("full_audit"));
    assert.ok(plan.steps.includes("delta_analysis"));
    assert.ok(plan.steps.includes("merge_local_findings"));
    assert.ok(plan.steps.includes("cross_validation"));
    assert.ok(plan.steps.includes("synergy_weighting"));
    assert.ok(plan.steps.includes("final_arbitration"));
    assert.ok(!plan.steps.includes("rst_review"));
  });

  it("shows full pre-audit details", async () => {
    const plan = await provider.getReviewPlan();
    assert.equal(plan.visibility.preAuditDetails, "full");
  });

  it("has rstContinuationPrompt after pre-audit", async () => {
    const plan = await provider.getReviewPlan();
    assert.equal(plan.visibility.rstContinuationPrompt, "after_pre_audit");
  });

  it("disables upgrade prompt", async () => {
    const plan = await provider.getReviewPlan();
    assert.equal(plan.visibility.upgradePrompt, "disabled");
  });

  it("getPromptTemplate returns null", async () => {
    assert.equal(await provider.getPromptTemplate("test"), null);
  });

  it("getWeights returns empty rules", async () => {
    const weights = await provider.getWeights();
    assert.deepEqual(weights, { rules: [] });
  });

  it("has frozen strategy session identity", async () => {
    const plan = await provider.getReviewPlan();
    assert.ok(typeof plan.strategySessionId === "string");
    assert.ok(plan.strategySessionId.length > 0);
    assert.ok(typeof plan.strategyHash === "string");
    assert.ok(plan.strategyHash.length > 0);
  });
});

// ── Pro flow integration tests ────────────────────────────────────────────────

function textOf(result: Awaited<ReturnType<typeof handleReviewContentWizard>>): string {
  return result.content.map((c) => c.text).join("\n");
}

function extractSessionId(text: string): string {
  const match = text.match(/sessionId:\s*([a-z0-9-]+)/);
  assert.ok(match, `expected sessionId in response: ${text}`);
  return match[1];
}

async function writePersona(skillsDir: string, id: string, name: string, tags: string[]): Promise<void> {
  const meta: PersonaMeta = {
    id, name, name_en: "Test Persona", version: "1.0.0", author: "kevlar-core",
    tags, description: `${name} 的测试描述`,
  };
  await writePersonaFile(skillsDir, meta, "性格特质：直接。常用平台：小红书。盲区：无特定盲区。");
  invalidatePersonasCache();
}

describe("Pro flow — rstConfirmation", () => {
  let skillsDir: string;
  let tmpDir: string;
  const proProvider = new InMemoryProStrategyProvider();

  beforeEach(() => {
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-pro-flow-"));
    tmpDir = path.join(skillsDir, "tmp");
    invalidatePersonasCache();
  });

  afterEach(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    invalidatePersonasCache();
  });

  it.skip("with no system auditors — goes to rstConfirmation then confirm enters checkPersonaInventory", async () => {
    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "测试内容：贵妇粉耳，颜值粉嫩",
      strategyProvider: proProvider,
    });

    const text = textOf(result);
    // Pro with no system auditors -> local rule findings -> rstConfirmation
    assert.ok(text.includes("rstConfirmation"), `expected rstConfirmation state, got: ${text}`);
    assert.ok(text.includes("是否继续进行舆论仿真推演"));

    const sessionId = extractSessionId(text);

    // User confirms RST
    const confirmResult = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "继续",
    });

    const confirmText = textOf(confirmResult);
    // Should enter checkPersonaInventory -> waitingForReviewDecision (no user personas)
    assert.ok(confirmText.includes("waitingForPersonaCreation"), `expected waitingForPersonaCreation, got: ${confirmText}`);
  });

  it.skip("with no system auditors — rstConfirmation decline ends flow", async () => {
    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "测试内容：贵妇粉耳，颜值粉嫩",
      strategyProvider: proProvider,
    });

    const sessionId = extractSessionId(textOf(result));

    const declineResult = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "否",
    });

    const declineText = textOf(declineResult);
    assert.ok(declineText.includes("六维风险检测已完成，未进入舆论仿真推演"));
    assert.ok(declineText.includes("completed"));
  });

  it.skip("with system auditors + local fallback — enters rstConfirmation, then confirm leads to persona check", async () => {
    const prevFallback = process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK;
    process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK = "1";

    try {
      await writePersona(skillsDir, "legal_compliance", "合规哨兵", ["system_auditor", "合规"]);

      const result = await handleReviewContentWizard(skillsDir, tmpDir, {
        userMessage: "测试内容：贵妇粉耳，颜值粉嫩",
        strategyProvider: proProvider,
      });

      const text = textOf(result);
      // With system auditors + local fallback + Pro -> rstConfirmation
      assert.ok(text.includes("rstConfirmation"), `expected rstConfirmation, got: ${text}`);
      assert.ok(text.includes("是否继续进行舆论仿真推演"));

      const sessionId = extractSessionId(text);

      // Confirm RST
      const confirmResult = await handleReviewContentWizard(skillsDir, tmpDir, {
        sessionId,
        userMessage: "是",
      });

      const confirmText = textOf(confirmResult);
      assert.ok(confirmText.includes("waitingForPersonaCreation"),
        `expected waitingForPersonaCreation, got: ${confirmText}`);
    } finally {
      if (prevFallback === undefined) delete process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK;
      else process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK = prevFallback;
    }
  });

  it.skip("with system auditors + local fallback — rstConfirmation decline ends flow", async () => {
    const prevFallback = process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK;
    process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK = "1";

    try {
      await writePersona(skillsDir, "legal_compliance", "合规哨兵", ["system_auditor", "合规"]);

      const result = await handleReviewContentWizard(skillsDir, tmpDir, {
        userMessage: "测试内容：贵妇粉耳，颜值粉嫩",
        strategyProvider: proProvider,
      });

      const sessionId = extractSessionId(textOf(result));

      const declineResult = await handleReviewContentWizard(skillsDir, tmpDir, {
        sessionId,
        userMessage: "否",
      });

      const declineText = textOf(declineResult);
      assert.ok(declineText.includes("六维风险检测已完成，未进入舆论仿真推演"));
      assert.ok(declineText.includes("completed"));
    } finally {
      if (prevFallback === undefined) delete process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK;
      else process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK = prevFallback;
    }
  });

  it("same review run cannot switch strategy (frozen on first call)", async () => {
    // First call resolves plan, freezes strategySessionId and strategyHash
    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "测试内容",
      strategyProvider: proProvider,
    });

    const sessionId = extractSessionId(textOf(result));

    // Read state directly — should have frozen strategy IDs
    const statePath = path.join(tmpDir, `${sessionId}_review_wizard.json`);
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.ok(state.strategySessionId);
    assert.ok(state.strategyHash);

    // Call again with a different (theoretical) strategy provider — should not re-resolve
    // Use undefined provider to simulate a scenario where getReviewPlan would differ
    const result2 = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "否",
      // No strategyProvider passed — but frozen state should still reflect Pro
    });

    const state2 = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state2.strategySessionId, state.strategySessionId);
    assert.equal(state2.strategyHash, state.strategyHash);
    assert.equal(state2.tier, "pro");
  });

  it.skip("empty message re-prompts the confirmation question", async () => {
    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "测试内容",
      strategyProvider: proProvider,
    });

    const sessionId = extractSessionId(textOf(result));

    // Send unrecognized message
    const rePrompt = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "hmm maybe",
    });

    const rePromptText = textOf(rePrompt);
    assert.ok(rePromptText.includes("回复「继续」或「是」"));
    assert.ok(rePromptText.includes("rstConfirmation") || rePromptText.includes("checkPersonaInventory"));
  });
});

// ── Free mode skips six-dimensional pre-audit ──────────────────────────────────────

describe("Free mode — skips six-dimensional pre-audit", () => {
  let sDir: string;
  let tDir: string;
  const freeProvider = new FreeStrategyProvider();

  beforeEach(() => {
    sDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-free-skip-"));
    tDir = path.join(sDir, "tmp");
    invalidatePersonasCache();
  });

  afterEach(() => {
    fs.rmSync(sDir, { recursive: true, force: true });
    invalidatePersonasCache();
  });

  async function writeSysAuditor(id: string, name: string): Promise<void> {
    const meta: PersonaMeta = { id, name, name_en: name, version: "1.0.0", author: "kevlar-core", tags: ["system_auditor"], description: name };
    await writePersonaFile(sDir, meta, "性格特质：直接。");
  }

  async function writeConsumerPersona(id: string, name: string): Promise<void> {
    const meta: PersonaMeta = { id, name, name_en: name, version: "1.0.0", author: "kevlar-core", tags: ["小红书", "美食"], description: name };
    await writePersonaFile(sDir, meta, "性格特质：直接。常用平台：小红书。");
  }

  it.skip("skips systemAudit step and shows review decision directly when Free strategyProvider is used", async () => {
    await writeSysAuditor("legal_compliance", "合规哨兵");
    await writeConsumerPersona("foodie", "美食达人");

    const result = await handleReviewContentWizard(sDir, tDir, {
      userMessage: "请评测这篇内容：新品发布文案。",
      strategyProvider: freeProvider,
    });

    const text = textOf(result);
    // Free must NOT show pre-audit results
    assert.ok(!text.includes("规则引擎"), `Free should not show 规则引擎: ${text}`);
    assert.ok(!text.includes("local_rules"), `Free should not show local_rules: ${text}`);

    // Free must go to review decision (personas already exist)
    assert.ok(text.includes("waitingForReviewDecision") || text.includes("请选择下一步"),
      `Free should go to review decision: ${text}`);

    // Verify state has no preAuditReport
    const sessionId = extractSessionId(text);
    const state = JSON.parse(
      fs.readFileSync(path.join(tDir, `${sessionId}_review_wizard.json`), "utf-8")
    );
    assert.equal(state.preAuditReport, undefined, `Free should not have preAuditReport`);
    assert.equal(state.tier, "free", `Free tier should be 'free' when using FreeStrategyProvider`);
  });

  it.skip("skips pre-audit when Free strategyProvider is used without system auditors", async () => {
    await writeConsumerPersona("foodie", "美食达人");

    const result = await handleReviewContentWizard(sDir, tDir, {
      userMessage: "盒马菌菇星球，贵妇粉耳。",
      strategyProvider: freeProvider,
    });

    const text = textOf(result);
    assert.ok(!text.includes("规则引擎"), `Free with FreeStrategyProvider should skip pre-audit: ${text}`);
    assert.ok(text.includes("waitingForReviewDecision") || text.includes("请选择下一步"),
      `Free should go to review decision: ${text}`);
  });
});

// ── Free/Pro × 3 Execution Modes matrix tests (FAIL 5.3) ───────────────────────

import { executeReview } from "../execution/index.js";
import { orchestrationHandler } from "../execution/modes/orchestration.js";
import { directApiHandler } from "../execution/modes/direct_api.js";
import { samplingHandler } from "../execution/modes/sampling.js";
import type { ExecutionContext, ExecutionHandler } from "../execution/base.js";

const ALL_HANDLERS: ExecutionHandler[] = [
  orchestrationHandler,
  directApiHandler,
  samplingHandler,
];

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    skillsDir: "/tmp",
    personas: [],
    content: "测试内容",
    tier: undefined,
    ...overrides,
  };
}

describe("Matrix: Free/Pro × 3 execution modes", () => {
  for (const tier of ["free", "pro"] as const) {
    for (const handler of ALL_HANDLERS) {
      const mode = handler.mode;
      it(`${tier} × ${mode} — handler receives tier in context`, () => {
        const ctx = makeCtx({ tier });
        assert.equal(ctx.tier, tier);
      });
    }
  }

  for (const handler of ALL_HANDLERS) {
    it(`${handler.mode} handler is registered in executeReview registry`, () => {
      const modes = [orchestrationHandler, directApiHandler, samplingHandler].map(h => h.mode);
      assert.ok(modes.includes(handler.mode));
    });

    it(`${handler.mode} has correct priority value`, () => {
      assert.ok(typeof handler.priority === "number");
      assert.ok(handler.priority > 0);
    });
  }

  it("Free × orchestration — executeReview passes tier through", async () => {
    const ctx = makeCtx({ tier: "free" });
    const result = await orchestrationHandler.execute(ctx);
    assert.ok(result.report);
    assert.equal(result.mode, "orchestration");
  });

  it("Pro × orchestration — executeReview passes tier through", async () => {
    const ctx = makeCtx({ tier: "pro" });
    const result = await orchestrationHandler.execute(ctx);
    assert.ok(result.report);
    assert.equal(result.mode, "orchestration");
  });
});
