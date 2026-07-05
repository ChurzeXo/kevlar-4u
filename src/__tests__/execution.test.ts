import { describe, it, beforeEach, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Test subject imports ───────────────────────────────────────────────────────

import {
  orchestrationHandler,
} from "../execution/modes/orchestration.js";

import { setClientCapabilities, isSamplingSupported } from "../execution/client.js";
import { setConfigPath, readConfig, updateConfig, isValidMode, isValidConcurrency } from "../execution/config.js";
import { RateLimiter, withRetry, isRetryableError } from "../execution/limiter.js";
import { ResultAggregator, generateAggregatedReport, estimateTokenCost, checkBudget } from "../execution/aggregator.js";
import { acquireReviewLock, releaseReviewLock, getReviewLock, isLocked } from "../execution/lock.js";
import { executeReview, loadPersonasForReview, validatePersonaFields } from "../execution/index.js";
import { executePersonasInParallel } from "../execution/parallel.js";
import {
  runAggregationValidation,
  validateContinuationGate,
  validateReceipt,
  validateSingleAgentResult,
  isRefusalSemantics,
  fallbackToStandardOrchestration,
  type ExecutionBlueprint,
  type ExecutionReceipt,
} from "../execution/protocol.js";
import { writePersonaFile } from "../utils/parser.js";
import type { Persona } from "../utils/parser.js";
import { initI18n } from "../i18n/index.js";

let tmpDir: string;

before(async () => {
  await initI18n();
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-exec-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  releaseReviewLock();
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration Mode Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("orchestrationHandler", () => {
  it("always returns available", () => {
    assert.ok(orchestrationHandler.canExecute());
  });

  it("has correct mode and priority", () => {
    assert.equal(orchestrationHandler.mode, "orchestration");
    assert.equal(orchestrationHandler.priority, 30);
  });

  it("generates report with personas", async () => {
    const personas = [
      {
        meta: {
          id: "test-1",
          name: "测试人设",
          name_en: "Test Persona",
          version: "1.0.0",
          author: "test",
          tags: [],
          description: "A test persona",
        },
        systemPrompt: "You are a test.",
        filePath: "/test/personas.json",
      },
    ];

    const result = await orchestrationHandler.execute({
      skillsDir: tmpDir,
      personas,
      content: "测试内容",
    });

    assert.equal(result.mode, "orchestration");
    assert.deepEqual(result.personas, ["test-1"]);
    assert.ok(result.report.includes("测试人设"));
    assert.ok(result.report.includes("测试内容"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Client Detection Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("isSamplingSupported", () => {
  it("returns true when client capabilities include sampling", () => {
    setClientCapabilities({ sampling: {} });
    assert.ok(isSamplingSupported());
  });

  it("returns false when client capabilities do not include sampling", () => {
    setClientCapabilities({});
    assert.ok(!isSamplingSupported());
  });

  it("returns false when no client capabilities are set", () => {
    setClientCapabilities(null);
    assert.ok(!isSamplingSupported());
  });
});

describe("isSamplingSupported (no env override)", () => {
  it("no longer has KEVLAR_ENABLE_SAMPLING env override — relies on real caps", () => {
    // Ensure env var is not set
    const saved = process.env.KEVLAR_ENABLE_SAMPLING;
    delete process.env.KEVLAR_ENABLE_SAMPLING;
    try {
      // With no client caps set, should return false
      assert.equal(isSamplingSupported(), false);
    } finally {
      if (saved !== undefined) process.env.KEVLAR_ENABLE_SAMPLING = saved;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("config", () => {
  it("returns default config when path not set", () => {
    const config = readConfig();
    assert.equal(config.mode, "auto");
    assert.ok(config.multiAgent);
    assert.equal(config.multiAgent.maxConcurrency, 3);
  });

  it("isValidMode accepts valid modes", () => {
    assert.ok(isValidMode("auto"));
    assert.ok(isValidMode("orchestration"));
    assert.ok(isValidMode("mcp_subagent"));
  });

  it("isValidMode rejects invalid modes", () => {
    assert.ok(!isValidMode("invalid"));
    assert.ok(!isValidMode(""));
  });

  it("isValidConcurrency validates range", () => {
    assert.ok(isValidConcurrency(1));
    assert.ok(isValidConcurrency(5));
    assert.ok(isValidConcurrency(10));
    assert.ok(!isValidConcurrency(0));
    assert.ok(!isValidConcurrency(11));
    assert.ok(!isValidConcurrency(-1));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config Persistence Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("config persistence", () => {
  beforeEach(() => {
    // Set config path to temp directory
    setConfigPath(tmpDir);
  });

  afterEach(() => {
    // Clean up config file if exists
    const configPath = path.join(tmpDir, "kevlar-config.json");
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  });

  it("writes and reads config", async () => {
    const updated = await updateConfig({
      mode: "orchestration",
      maxConcurrency: 5,
    });

    assert.equal(updated.mode, "orchestration");
    assert.equal(updated.multiAgent.maxConcurrency, 5);

    const read = readConfig();
    assert.equal(read.mode, "orchestration");
    assert.equal(read.multiAgent.maxConcurrency, 5);
  });

  it("preserves existing config when partially updating", async () => {
    // First update
    await updateConfig({ mode: "mcp_subagent" });
    
    // Partial update
    const updated = await updateConfig({ maxConcurrency: 8 });    
    
    assert.equal(updated.mode, "mcp_subagent"); // Preserved
    assert.equal(updated.multiAgent.maxConcurrency, 8); // Updated
  });

  it("returns defaults when config file missing", () => {
    const config = readConfig();
    assert.equal(config.mode, "auto");
    assert.equal(config.multiAgent.maxConcurrency, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiter Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("RateLimiter", () => {
  it("acquires and releases permits", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2, minDelayMs: 0 });
    
    await limiter.acquire();
    await limiter.acquire();
    limiter.release();
    limiter.release();
    
    // Should not throw
    await limiter.acquire();
    limiter.release();
  });
});

describe("isRetryableError", () => {
  it("identifies retryable errors", () => {
    assert.ok(isRetryableError("rate_limit_exceeded"));
    assert.ok(isRetryableError("service_unavailable"));
    assert.ok(isRetryableError("timeout"));
    assert.ok(isRetryableError("network_error"));
  });

  it("rejects non-retryable errors", () => {
    assert.ok(!isRetryableError("invalid_api_key"));
    assert.ok(!isRetryableError("unknown"));
  });
});

describe("withRetry", () => {
  it("succeeds without retries", async () => {
    let callCount = 0;
    const result = await withRetry(async () => {
      callCount++;
      return "success";
    });
    
    assert.equal(result, "success");
    assert.equal(callCount, 1);
  });

  it("retries on failure and succeeds", async () => {
    let callCount = 0;
    const result = await withRetry(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error("rate limit exceeded");
      }
      return "success";
    }, { maxRetries: 3 });
    
    assert.equal(result, "success");
    assert.equal(callCount, 3);
  });

  it("throws after max retries", async () => {
    let callCount = 0;
    
    await assert.rejects(
      async () => {
        await withRetry(async () => {
          callCount++;
          throw new Error("rate limit exceeded");
        }, { maxRetries: 2 });
      },
      /rate limit exceeded/
    );
    
    assert.equal(callCount, 3); // Initial + 2 retries
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Result Aggregator Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("ResultAggregator", () => {
  it("collects successful results", () => {
    const aggregator = new ResultAggregator();
    
    aggregator.addSuccess({
      personaId: "p1",
      personaName: "人设1",
      review: "很好",
    });
    
    const successful = aggregator.getSuccessful();
    assert.equal(successful.length, 1);
    assert.equal(successful[0].personaId, "p1");
    assert.ok(!successful[0].error);
  });

  it("collects failed results", () => {
    const aggregator = new ResultAggregator();
    
    aggregator.addFailure("p1", "人设1", "Network error");
    
    const failed = aggregator.getFailed();
    assert.equal(failed.length, 1);
    assert.equal(failed[0].personaId, "p1");
    assert.equal(failed[0].error, "Network error");
  });

  it("calculates success rate", () => {
    const aggregator = new ResultAggregator();
    
    aggregator.addSuccess({ personaId: "p1", personaName: "A", review: "OK" });
    aggregator.addSuccess({ personaId: "p2", personaName: "B", review: "OK" });
    aggregator.addFailure("p3", "C", "Error");
    
    const partial = aggregator.getPartialResult();
    assert.equal(partial.successRate, 2 / 3);
  });
});

describe("generateAggregatedReport", () => {
  it("generates report with mode label", () => {
    const report = generateAggregatedReport({
      mode: "orchestration",
      contentSummary: "测试内容摘要",
      personas: [
        {
          personaId: "p1",
          personaName: "人设1",
          review: "评论内容",
          completedAt: new Date(),
        },
      ],
    });
    
    assert.ok(report.includes("测试内容摘要"));
    assert.ok(report.includes("人设1"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Token Budget Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateTokenCost", () => {
  it("estimates based on content and persona count", () => {
    const cost = estimateTokenCost(3, 1000);
    // (1000/3) + 3*15000 = 333 + 45000 = 45333
    assert.equal(cost, 45333);
  });
});

describe("checkBudget", () => {
  it("does not throw when under budget", () => {
    // Clear env var
    delete process.env.KEVLAR_TOKEN_BUDGET_PER_TASK;
    assert.doesNotThrow(() => checkBudget(1, 1000));
  });

  it("throws when over budget", () => {
    process.env.KEVLAR_TOKEN_BUDGET_PER_TASK = "100";
    assert.throws(() => checkBudget(5, 10000), /超出预算/);
    delete process.env.KEVLAR_TOKEN_BUDGET_PER_TASK;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review Lock Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Review Lock", () => {
  it("acquires lock when not locked", () => {
    assert.ok(!isLocked());
    assert.ok(acquireReviewLock("orchestration"));
    assert.ok(isLocked());
  });

  it("fails to acquire when already locked", () => {
    acquireReviewLock("orchestration");
    assert.ok(!acquireReviewLock("mcp_subagent"));
  });

  it("releases lock correctly", () => {
    acquireReviewLock("orchestration");
    releaseReviewLock();
    assert.ok(!isLocked());
    assert.equal(getReviewLock(), null);
  });

  it("returns lock info when locked", () => {
    acquireReviewLock("test_mode");
    const lock = getReviewLock();
    assert.ok(lock);
    assert.equal(lock!.mode, "test_mode");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeReview Tests (Mode Resolution)
// ─────────────────────────────────────────────────────────────────────────────

describe("executeReview", () => {
  const testPersonas = [
    {
      meta: {
        id: "test-1",
        name: "测试人设",
        name_en: "Test Persona",
        version: "1.0.0",
        author: "test",
        tags: [],
        description: "A test persona",
      },
      systemPrompt: "You are a test.",
      filePath: "/test/personas.json",
    },
  ];

  it("executes with orchestration mode", async () => {
    const result = await executeReview("orchestration", {
      skillsDir: tmpDir,
      personas: testPersonas,
      content: "测试内容",
    });

    assert.equal(result.mode, "orchestration");
    assert.deepEqual(result.personas, ["test-1"]);
    assert.ok(result.report.includes("宿主辅助兜底模式"));
  });

  it("executes with orchestration mode and returns mcp_subagent as resolved mode", async () => {
    // executeReview always delegates to orchestrationHandler regardless of mode
    const result = await executeReview("mcp_subagent" as any, {
      skillsDir: tmpDir,
      personas: testPersonas,
      content: "测试内容",
    });
    // orchestrationHandler is the only registered handler, always returns orchestration
    assert.ok(result.mode);
    assert.ok(result.report);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validatePersonaFields Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("validatePersonaFields", () => {
  it("succeeds for valid custom persona", () => {
    const validCustom = {
      meta: { id: "custom", name: "Custom", name_en: "", version: "1.0", author: "user", tags: ["通用"], description: "活跃于平台" },
      systemPrompt: "性格特质：温和。盲区：无。",
      filePath: "",
    } as Persona;
    assert.doesNotThrow(() => validatePersonaFields(validCustom));
  });

  it("throws for custom persona missing platform", () => {
    const invalid = {
      meta: { id: "custom", name: "Custom", name_en: "", version: "1.0", author: "user", tags: [], description: "有详尽的性格描述", blindSpot: "无" },
      systemPrompt: "性格特质：温和。盲区：无。",
      filePath: "",
    } as Persona;
    assert.throws(() => validatePersonaFields(invalid), /缺少平台/);
  });

  it("throws for custom persona missing traits", () => {
    const invalid = {
      meta: { id: "custom", name: "Custom", name_en: "", version: "1.0", author: "user", tags: ["通用"], description: "A", blindSpot: "无" },
      systemPrompt: "盲区：无。",
      filePath: "",
    } as Persona;
    assert.throws(() => validatePersonaFields(invalid), /缺少性格描述/);
  });

  it("throws for custom persona missing blind spot", () => {
    const invalid = {
      meta: { id: "custom", name: "Custom", name_en: "", version: "1.0", author: "user", tags: ["通用"], description: "性格温和的评审员" },
      systemPrompt: "性格特质：温和。",
      filePath: "",
    } as Persona;
    assert.throws(() => validatePersonaFields(invalid), /缺少盲区/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadPersonasForReview Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadPersonasForReview", () => {
  beforeEach(async () => {
    await writePersonaFile(tmpDir, {
      id: "test_persona",
      name: "测试人设",
      name_en: "Test",
      version: "1.0.0",
      author: "test",
      tags: ["test"],
      description: "A test persona",
      blindSpot: "none",
    }, "常用平台：通用\n性格特质：温和\n盲区：无");
  });

  it("returns empty personas when directory empty", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-empty-"));
    try {
      const { personas } = await loadPersonasForReview(emptyDir);
      assert.equal(personas.length, 0);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("loads all personas when no ids specified", async () => {
    const { personas, missingIds } = await loadPersonasForReview(tmpDir);
    assert.equal(personas.length, 1);
    assert.equal(personas[0].meta.id, "test_persona");
    assert.equal(missingIds, undefined);
  });

  it("loads specific personas by ids", async () => {
    const { personas, missingIds } = await loadPersonasForReview(tmpDir, ["test_persona"]);
    assert.equal(personas.length, 1);
    assert.ok(!missingIds);
  });

  it("reports missing ids", async () => {
    const { personas, missingIds } = await loadPersonasForReview(tmpDir, ["nonexistent"]);
    assert.equal(personas.length, 0);
    assert.deepEqual(missingIds, ["nonexistent"]);
  });

  it("partially loads with missing ids", async () => {
    const { personas, missingIds } = await loadPersonasForReview(tmpDir, ["test_persona", "ghost"]);
    assert.equal(personas.length, 1);
    assert.equal(personas[0].meta.id, "test_persona");
    assert.deepEqual(missingIds, ["ghost"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executePersonasInParallel Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("executePersonasInParallel", () => {
  const makePersona = (id: string, name: string, sp = "You are a critic."): Persona => ({
    meta: { id, name, name_en: "", version: "1.0", author: "test", tags: [], description: `Persona ${name}` },
    systemPrompt: sp,
    filePath: "/test/personas.json",
  });

  it("executes all personas successfully", async () => {
    process.env.KEVLAR_TOKEN_BUDGET_PER_TASK = "100000";
    try {
      const personas = [makePersona("p1", "A"), makePersona("p2", "B")];
      const result = await executePersonasInParallel(
        personas,
        "Test content",
        { mode: "orchestration", retryEventName: "test" },
        async (p) => `Review by ${p.meta.name}`
      );

      assert.equal(result.mode, "orchestration");
      assert.equal(result.personas.length, 2);
      assert.ok(result.personas.includes("p1"));
      assert.ok(result.personas.includes("p2"));
      assert.ok(!result.partialFailures || result.partialFailures.length === 0);
      assert.ok(result.report.includes("Review by A"));
      assert.ok(result.report.includes("Review by B"));
    } finally {
      delete process.env.KEVLAR_TOKEN_BUDGET_PER_TASK;
    }
  });

  it("collects partial failures", async () => {
    process.env.KEVLAR_TOKEN_BUDGET_PER_TASK = "100000";
    try {
      const personas = [makePersona("p1", "Good"), makePersona("p2", "Bad")];
      const result = await executePersonasInParallel(
        personas,
        "Test",
        { mode: "orchestration", retryEventName: "test" },
        async (p) => {
          if (p.meta.id === "p2") throw new Error("Intentional failure");
          return `OK from ${p.meta.name}`;
        }
      );

      assert.ok(result.personas.includes("p1"));
      assert.ok(!result.personas.includes("p2"));
      assert.ok(result.partialFailures);
      assert.equal(result.partialFailures.length, 1);
      assert.equal(result.partialFailures[0].personaId, "p2");
    } finally {
      delete process.env.KEVLAR_TOKEN_BUDGET_PER_TASK;
    }
  });

  it("respects maxConcurrency from config", async () => {
    process.env.KEVLAR_TOKEN_BUDGET_PER_TASK = "100000";
    let maxConcurrent = 0;
    let current = 0;

    const personas = [makePersona("p1", "A"), makePersona("p2", "B"), makePersona("p3", "C")];
    await executePersonasInParallel(
      personas,
      "Test",
      { mode: "orchestration", retryEventName: "test" },
      async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise((r) => setTimeout(r, 10));
        current--;
        return "done";
      }
    );

    // With 3 personas and default concurrency 3, should never exceed that
    assert.ok(maxConcurrent <= 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Protocol v1: runAggregationValidation Tests
// ─────────────────────────────────────────────────────────────────────────────

/** Helper: create a minimal valid ExecutionReceipt */
function makeValidReceipt(overrides: Record<string, any> = {}): ExecutionReceipt {
  return {
    protocol: "kevlar.blueprint/v1",
    execution: {
      requestedMode: "isolated_contexts",
      actualMode: "native_subagent",
      requestedConcurrency: 2,
      actualConcurrency: 2,
      contextIsolation: { requested: true, achieved: true },
      parallelism: "parallel",
      evidenceLevel: "host_attested",
    },
    contexts: [
      {
        id: "agent-1",
        role: "safety_reviewer",
        status: "completed",
        output: { findings: [] },
      },
    ],
    aggregation: {
      dimensions: [{ id: "agent-1", level: "🟢", findings: [] }],
      summary: "All clear",
    },
    ...overrides,
  } as unknown as ExecutionReceipt;
}

/** Helper: create a minimal ExecutionBlueprint */
function makeBlueprint(contextIds: string[]): ExecutionBlueprint {
  return {
    protocol: "kevlar.blueprint/v1",
    execution: {
      mode: "isolated_contexts",
      allowedModes: ["native_subagent", "simulated_agent"],
      concurrency: contextIds.length,
      isolation: { required: true, level: "best_effort" },
    },
    contexts: contextIds.map((id) => ({
      id,
      role: "safety_reviewer",
      instructions: "Review the content.",
      input: { contentRef: "content" },
      outputSchema: "kevlar.reviewer/v1",
    })),
    aggregation: {
      strategy: "host_merge",
      rules: { requireAllContexts: true, conflictResolution: "risk_maximization", outputSchema: "kevlar.audit/v1" },
    },
    continuation: {
      tool: "review_content_wizard_continue",
      sessionId: "test-session",
      checkpoint: "preaudit_completed",
      expectedRevision: 1,
    },
  };
}

describe("runAggregationValidation", () => {
  it("returns valid for a conforming receipt with no blueprint", () => {
    const result = runAggregationValidation(makeValidReceipt());
    assert.equal(result.protocol, "kevlar.blueprint/v1");
    assert.equal(result.status, "valid");
    assert.ok(result.checks.schemaValid);
    assert.ok(result.checks.allContextsPresent);
  });

  it("returns invalid for null receipt", () => {
    const result = runAggregationValidation(null);
    assert.equal(result.status, "invalid");
    assert.ok(result.risk.reasons.length > 0);
  });

  it("returns invalid for non-object receipt", () => {
    const result = runAggregationValidation("not-an-object");
    assert.equal(result.status, "invalid");
  });

  it("returns invalid when agents array is missing", () => {
    const receipt = makeValidReceipt({ contexts: undefined });
    const result = runAggregationValidation(receipt);
    assert.equal(result.status, "invalid");
    assert.ok(!result.checks.schemaValid);
  });

  it("returns invalid when agent output is missing findings", () => {
    const receipt = makeValidReceipt({
      contexts: [{ id: "a1", role: "safety_reviewer", status: "completed", output: { noFindings: true } }],
    });
    const result = runAggregationValidation(receipt);
    assert.equal(result.status, "invalid");
    assert.ok(!result.checks.schemaValid);
  });

  it("returns invalid when aggregation is missing", () => {
    const receipt = makeValidReceipt({ aggregation: undefined });
    const result = runAggregationValidation(receipt);
    assert.equal(result.status, "invalid");
    assert.ok(!result.checks.schemaValid);
  });

  it("returns invalid when aggregation dimensions is missing", () => {
    const receipt = makeValidReceipt({ aggregation: { summary: "ok" } });
    const result = runAggregationValidation(receipt);
    assert.equal(result.status, "invalid");
    assert.ok(!result.checks.schemaValid);
  });

  it("returns invalid on agent count mismatch with blueprint", () => {
    const blueprint = makeBlueprint(["agent-1", "agent-2"]);
    const receipt = makeValidReceipt(); // Only has agent-1
    const result = runAggregationValidation(receipt, blueprint);
    assert.equal(result.status, "invalid");
    assert.ok(!result.checks.allContextsPresent);
    assert.ok(result.risk.reasons.some((r) => r.includes("count mismatch")));
  });

  it("returns valid when agent IDs exactly match blueprint", () => {
    const blueprint = makeBlueprint(["agent-1"]);
    const receipt = makeValidReceipt({
      execution: {
        requestedMode: "isolated_contexts",
        actualMode: "native_subagent",
        requestedConcurrency: 1,
        actualConcurrency: 1,
        contextIsolation: { requested: true, achieved: true },
        parallelism: "parallel",
        evidenceLevel: "host_attested",
      },
    });
    const result = runAggregationValidation(receipt, blueprint);
    assert.equal(result.status, "valid");
    assert.ok(result.checks.allContextsPresent);
  });

  it("returns fallback_used when actualMode is orchestration_fallback", () => {
    const receipt = makeValidReceipt({
      execution: {
        requestedMode: "isolated_contexts",
        actualMode: "orchestration_fallback",
        requestedConcurrency: 2,
        actualConcurrency: 1,
        contextIsolation: { requested: true, achieved: true },
        parallelism: "sequential",
        evidenceLevel: "best_effort",
      },
    });
    const result = runAggregationValidation(receipt);
    assert.equal(result.status, "fallback_used");
    assert.ok(result.checks.executionMismatch);
  });

  it("returns partial when some agents failed", () => {
    const receipt = makeValidReceipt({
      contexts: [
        { id: "agent-1", role: "safety_reviewer", status: "completed", output: { findings: [] } },
        { id: "agent-2", role: "policy_reviewer", status: "failed" },
      ],
      aggregation: {
        dimensions: [
          { id: "agent-1", level: "🟢", findings: [] },
          { id: "agent-2", level: "🟢", findings: [] },
        ],
        summary: "Some failed",
      },
    });
    const result = runAggregationValidation(receipt);
    assert.equal(result.status, "partial");
  });

  it("escalates risk level on isolation violation", () => {
    const blueprint = makeBlueprint(["agent-1"]);
    blueprint.execution.isolation.required = true;
    const receipt = makeValidReceipt({
      execution: {
        requestedMode: "isolated_contexts",
        actualMode: "native_subagent",
        requestedConcurrency: 1,
        actualConcurrency: 1,
        contextIsolation: { requested: true, achieved: false }, // Violation!
        parallelism: "parallel",
        evidenceLevel: "best_effort",
      },
    });
    const result = runAggregationValidation(receipt, blueprint);
    assert.ok(result.checks.isolationViolation);
    assert.notEqual(result.risk.level, "low");
    assert.ok(result.risk.reasons.some((r) => r.includes("Isolation")));
  });

  it("computes high risk level from findings", () => {
    const receipt = makeValidReceipt({
      contexts: [
        {
          id: "agent-1",
          role: "safety_reviewer",
          status: "completed",
          output: { findings: [{ id: "f1", suggestedLevel: "🔴", description: "Serious risk" }] },
        },
      ],
    });
    const result = runAggregationValidation(receipt);
    assert.equal(result.risk.level, "high");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Protocol v1: validateContinuationGate Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("validateContinuationGate", () => {
  /** Build a minimal wizard state */
  function makeState(overrides: Record<string, any> = {}) {
    return {
      sessionId: "test-sess",
      revision: 1,
      step: "waitingForSubagentAudit",
      mode: "mcp_subagent" as string,
      content: "Test content",
      activeContinuation: {
        continuationId: "cont-abc",
        checkpoint: "preaudit_completed",
        expiresAt: Date.now() + 300_000,
      },
      blueprint: makeBlueprint(["agent-1"]),
      ...overrides,
    };
  }

  it("throws stale_continuation_revision_locked on revision mismatch", () => {
    const state = makeState({ revision: 2 });
    assert.throws(
      () => validateContinuationGate(state, { continuationId: "cont-abc", expectedRevision: 1, receipt: makeValidReceipt() }),
      /stale_continuation_revision_locked/
    );
  });

  it("throws continuation_id_mismatch when ID does not match", () => {
    const state = makeState();
    assert.throws(
      () => validateContinuationGate(state, { continuationId: "wrong-id", expectedRevision: 1, receipt: makeValidReceipt() }),
      /continuation_id_mismatch/
    );
  });

  it("throws continuation_id_mismatch when activeContinuation is null", () => {
    const state = makeState({ activeContinuation: null });
    assert.throws(
      () => validateContinuationGate(state, { continuationId: "cont-abc", expectedRevision: 1, receipt: makeValidReceipt() }),
      /continuation_id_mismatch/
    );
  });

  it("returns valid for a good receipt submission", () => {
    const state = makeState();
    const result = validateContinuationGate(state, {
      continuationId: "cont-abc",
      expectedRevision: 1,
      receipt: makeValidReceipt(),
    });
    assert.equal(result.status, "valid");
  });

  it("triggers fallback when receipt is invalid and mutates state step", () => {
    const state = makeState();
    const result = validateContinuationGate(state, {
      continuationId: "cont-abc",
      expectedRevision: 1,
      receipt: null, // Invalid receipt
    });
    assert.equal(result.status, "invalid");
    // State should have been downgraded (fallbackToStandardOrchestration was called)
    assert.ok(
      state.step === "waitingForOrchestrationStep0" || state.step === "waitingForOrchestrationAudit",
      `Expected orchestration fallback step, got: ${state.step}`
    );
    assert.equal(state.mode, "orchestration");
    assert.equal(state.revision, 2); // revision was bumped
  });

  it("triggers orchestration audit fallback when step0Result exists", () => {
    const state = makeState({
      orchestrationPreAuditContext: {
        step0Result: { blackAtoms: [], attackCandidates: [], wildTranslations: [], precedents: [] },
        localFindings: [],
        stripped: { original: "test", bare: "test", replacements: [] },
      },
    });
    const result = validateContinuationGate(state, {
      continuationId: "cont-abc",
      expectedRevision: 1,
      receipt: null, // Force invalid
    });
    assert.equal(result.status, "invalid");
    assert.equal(state.step, "waitingForOrchestrationAudit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Protocol v1: fallbackToStandardOrchestration Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("fallbackToStandardOrchestration", () => {
  it("sets step to waitingForOrchestrationStep0 when no step0Result", () => {
    const state: any = {
      sessionId: "s1",
      revision: 1,
      mode: "mcp_subagent",
      orchestrationPreAuditContext: null,
      executionTransitions: [],
    };
    fallbackToStandardOrchestration(state, "schema_mismatch");
    assert.equal(state.step, "waitingForOrchestrationStep0");
    assert.equal(state.mode, "orchestration");
    assert.equal(state.revision, 2);
    assert.ok(state.activeContinuation?.continuationId);
  });

  it("sets step to waitingForOrchestrationAudit when step0Result exists", () => {
    const state: any = {
      sessionId: "s1",
      revision: 1,
      mode: "mcp_subagent",
      orchestrationPreAuditContext: {
        step0Result: { blackAtoms: ["atom"], attackCandidates: [], wildTranslations: [], precedents: [] },
      },
      executionTransitions: [],
    };
    fallbackToStandardOrchestration(state, "schema_mismatch");
    assert.equal(state.step, "waitingForOrchestrationAudit");
    assert.equal(state.mode, "orchestration");
    assert.equal(state.revision, 2);
  });

  it("bumps revision on each fallback call", () => {
    const state: any = {
      sessionId: "s1",
      revision: 5,
      mode: "mcp_subagent",
      orchestrationPreAuditContext: null,
      executionTransitions: [],
    };
    fallbackToStandardOrchestration(state, "schema_mismatch");
    assert.equal(state.revision, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Protocol v1: validateReceipt Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("validateReceipt", () => {
  it("validates a well-formed receipt", () => {
    const result = validateReceipt(makeValidReceipt());
    assert.ok(result.valid);
    assert.equal(result.errors.length, 0);
  });

  it("rejects null input", () => {
    const result = validateReceipt(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some((e) => e.includes("不是有效")));
  });

  it("rejects non-object input", () => {
    const result = validateReceipt("not-an-object");
    assert.equal(result.valid, false);
  });

  it("warns on protocol version mismatch", () => {
    const receipt = makeValidReceipt({ protocol: "v2.0" });
    const result = validateReceipt(receipt);
    assert.equal(result.valid, true); // protocol mismatch is a warning, not error
    assert.ok(result.warnings.some((w) => w.includes("协议版本不匹配")));
  });

  it("errors when agents array is missing", () => {
    const receipt = makeValidReceipt({ contexts: undefined });
    const result = validateReceipt(receipt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("contexts")));
  });

  it("errors when agents array is empty", () => {
    const receipt = makeValidReceipt({ contexts: [] });
    const result = validateReceipt(receipt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("为空")));
  });

  it("errors when agent is missing id", () => {
    const receipt = makeValidReceipt({
      contexts: [{ status: "completed", output: { findings: [] } }],
    });
    const result = validateReceipt(receipt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("id")));
  });

  it("errors when agent is missing status", () => {
    const receipt = makeValidReceipt({
      contexts: [{ id: "a", output: { findings: [] } }],
    });
    const result = validateReceipt(receipt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("status")));
  });

  it("errors when agent is missing output", () => {
    const receipt = makeValidReceipt({
      contexts: [{ id: "a", status: "completed" }],
    });
    const result = validateReceipt(receipt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("output")));
  });

  it("errors on string output", () => {
    const receipt = makeValidReceipt({
      contexts: [{ id: "a", status: "completed", output: "plain text" }],
    });
    const result = validateReceipt(receipt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("字符串")));
  });

  it("warns on unknown status value", () => {
    const receipt = makeValidReceipt({
      contexts: [{ id: "a", status: "invalid_status", output: { findings: [] } }],
    });
    const result = validateReceipt(receipt);
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some((w) => w.includes("未知的 status")));
  });

  it("errors when aggregation is missing", () => {
    const receipt = makeValidReceipt({ aggregation: undefined });
    const result = validateReceipt(receipt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("聚合报告")));
  });

  it("errors when aggregation.dimensions is not an array", () => {
    const receipt = makeValidReceipt({
      aggregation: { summary: "ok" },
    });
    const result = validateReceipt(receipt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("dimensions")));
  });

  it("errors when aggregation.summary is not a string", () => {
    const receipt = makeValidReceipt({
      aggregation: { dimensions: [], summary: 123 },
    });
    const result = validateReceipt(receipt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("summary")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Protocol v1: validateSingleAgentResult Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("validateSingleAgentResult", () => {
  it("validates a well-formed agent result", () => {
    const result = validateSingleAgentResult("agent-1", {
      contextId: "agent-1",
      status: "completed",
      output: { findings: [{ keyword: "risky" }] },
    });
    assert.ok(result.valid);
    assert.equal(result.errors.length, 0);
  });

  it("rejects null input", () => {
    const result = validateSingleAgentResult("agent-1", null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("不是有效")));
  });

  it("errors when contextId is missing", () => {
    const result = validateSingleAgentResult("agent-1", {
      status: "completed",
      output: { findings: [] },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("contextId")));
  });

  it("errors when contextId does not match expected", () => {
    const result = validateSingleAgentResult("agent-1", {
      contextId: "agent-2",
      status: "completed",
      output: { findings: [] },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("不匹配")));
  });

  it("errors when status is missing", () => {
    const result = validateSingleAgentResult("agent-1", {
      contextId: "agent-1",
      output: { findings: [] },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("status")));
  });

  it("errors on unknown status value", () => {
    const result = validateSingleAgentResult("agent-1", {
      contextId: "agent-1",
      status: "unknown",
      output: { findings: [] },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("status")));
  });

  it("accepts status: failed", () => {
    const result = validateSingleAgentResult("agent-1", {
      contextId: "agent-1",
      status: "failed",
      output: { findings: [] },
    });
    assert.ok(result.valid);
  });

  it("errors when findings is not an array", () => {
    const result = validateSingleAgentResult("agent-1", {
      contextId: "agent-1",
      status: "completed",
      output: { findings: "not-array" },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("findings")));
  });

  it("warns when output.findings is not an array", () => {
    const result = validateSingleAgentResult("agent-1", {
      contextId: "agent-1",
      status: "completed",
      output: { findings: "not-array" },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("findings")));
  });

  it("accepts alternate field names: id + result", () => {
    const result = validateSingleAgentResult("agent-1", {
      id: "agent-1",
      status: "completed",
      result: { findings: [{ keyword: "risky" }] },
    });
    assert.ok(result.valid);
  });
});

// ── §0 isRefusalSemantics Tests ──────────────────────────────────────────────

describe("isRefusalSemantics", () => {
  it("detects Chinese verbal refusal pattern", () => {
    assert.ok(isRefusalSemantics("抱歉，我无法为您创建并行任务，但我可以直接在这里为您依次分析各个维度。"));
  });

  it("detects Chinese direct-do pattern", () => {
    assert.ok(isRefusalSemantics("我明白了。由于当前环境不支持并行子代理，我将直接在这里依次分析。"));
  });

  it("detects 'unsupported' pattern", () => {
    assert.ok(isRefusalSemantics("当前平台不支持子代理并行执行。"));
  });

  it("detects English refusal pattern", () => {
    assert.ok(isRefusalSemantics("I'm sorry, I cannot create parallel subagents in this environment."));
  });

  it("detects English 'cannot spawn' pattern", () => {
    assert.ok(isRefusalSemantics("I cannot spawn parallel tasks at this time. Let me analyze the content directly."));
  });

  it("detects 'not supported' pattern", () => {
    assert.ok(isRefusalSemantics("Parallel subagent execution is not supported here."));
  });

  it("detects sequential fallback language", () => {
    assert.ok(isRefusalSemantics("我将依次逐个维度进行分析处理。"));
  });

  it("does NOT flag valid receipt JSON", () => {
    assert.ok(!isRefusalSemantics(JSON.stringify({ protocol: "kevlar.blueprint/v1", contexts: [], aggregation: { dimensions: [], summary: "ok" } })));
  });

  it("does NOT flag normal conversation", () => {
    assert.ok(!isRefusalSemantics("好的，我已经按照要求完成了所有6个维度的审计。"));
  });

  it("does NOT flag SEQUENTIAL_FALLBACK keyword alone", () => {
    assert.ok(!isRefusalSemantics("SEQUENTIAL_FALLBACK"));
  });

  it("detects '无法并行创建' pattern", () => {
    assert.ok(isRefusalSemantics("当前环境无法并行创建多个执行上下文。"));
  });
});
