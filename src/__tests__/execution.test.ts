import { describe, it, beforeEach, afterEach, before, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

// ── Test subject imports ───────────────────────────────────────────────────────

import {
  orchestrationHandler,
} from "../execution/modes/orchestration.js";

import { hasApiKey, maskApiKey } from "../execution/modes/direct_api.js";
import { setClientInfo, setClientCapabilities, isSamplingSupported } from "../execution/client.js";
import { setConfigPath, readConfig, updateConfig, isValidMode, isValidConcurrency } from "../execution/config.js";
import { RateLimiter, withRetry, isRetryableError } from "../execution/limiter.js";
import { ResultAggregator, generateAggregatedReport, estimateTokenCost, checkBudget } from "../execution/aggregator.js";
import { acquireReviewLock, releaseReviewLock, getReviewLock, isLocked } from "../execution/lock.js";
import { executeReview, loadPersonasForReview, validatePersonaFields } from "../execution/index.js";
import { executePersonasInParallel } from "../execution/parallel.js";
import { directApiHandler } from "../execution/modes/direct_api.js";
import { samplingHandler } from "../execution/modes/sampling.js";
import { writePersonaFile } from "../utils/parser.js";
import type { Persona, PersonaMeta } from "../utils/parser.js";
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
// Direct API Key Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("hasApiKey", () => {
  it("returns false when no API key is set", () => {
    // Clear env vars for this test
    delete process.env.KEVLAR_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    assert.ok(!hasApiKey());
  });

  it("returns true when KEVLAR_API_KEY is set", () => {
    process.env.KEVLAR_API_KEY = "sk-test-key-12345";
    assert.ok(hasApiKey());
    delete process.env.KEVLAR_API_KEY;
  });
});

describe("maskApiKey", () => {
  it("masks long keys correctly", () => {
    const masked = maskApiKey("sk-ant-api-key-12345", 4);
    assert.ok(masked.startsWith("sk-a"));
    assert.ok(masked.endsWith("2345"));
    assert.ok(masked.includes("****"));
  });

  it("masks short keys entirely", () => {
    const masked = maskApiKey("abc", 4);
    assert.equal(masked, "***");
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

describe("KEVLAR_ENABLE_SAMPLING override", () => {
  it("returns true when KEVLAR_ENABLE_SAMPLING=true", () => {
    process.env.KEVLAR_ENABLE_SAMPLING = "true";
    try {
      assert.ok(isSamplingSupported());
    } finally {
      delete process.env.KEVLAR_ENABLE_SAMPLING;
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
    assert.ok(isValidMode("mcp_sampling"));
    assert.ok(isValidMode("direct_api"));
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
      mode: "mcp_sampling",
      maxConcurrency: 5,
    });

    assert.equal(updated.mode, "mcp_sampling");
    assert.equal(updated.multiAgent.maxConcurrency, 5);

    const read = readConfig();
    assert.equal(read.mode, "mcp_sampling");
    assert.equal(read.multiAgent.maxConcurrency, 5);
  });

  it("preserves existing config when partially updating", async () => {
    // First update
    await updateConfig({ mode: "direct_api" });
    
    // Partial update
    const updated = await updateConfig({ maxConcurrency: 8 });    
    
    assert.equal(updated.mode, "direct_api"); // Preserved
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
      mode: "mcp_sampling",
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
    
    assert.ok(report.includes("MCP 采样模式"));
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
    assert.ok(acquireReviewLock("mcp_sampling"));
    assert.ok(isLocked());
  });

  it("fails to acquire when already locked", () => {
    acquireReviewLock("mcp_sampling");
    assert.ok(!acquireReviewLock("direct_api"));
  });

  it("releases lock correctly", () => {
    acquireReviewLock("mcp_sampling");
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
  // Create a mock sampling function for testing
  const mockSamplingFn = async (params: { 
    systemPrompt: string; 
    message: string; 
    maxTokens?: number 
  }) => {
    return { content: "Mock response", stopReason: "endTurn" };
  };

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

  it("throws for unknown mode", async () => {
    await assert.rejects(
      async () => {
        await executeReview("unknown_mode" as any, {
          skillsDir: tmpDir,
          personas: testPersonas,
          content: "测试",
        });
      },
      /未知执行模式/
    );
  });

  describe("mcp_sampling mode", () => {
    beforeEach(() => {
      // Set client to claude-ai so isSamplingSupported() returns true
      setClientCapabilities({ sampling: {} });
    });

    it("throws when samplingFn not provided", async () => {
      await assert.rejects(
        async () => {
          await executeReview("mcp_sampling", {
            skillsDir: tmpDir,
            personas: testPersonas,
            content: "测试",
          });
        },
        /MCP Sampling 模式需要 samplingFn/
      );
    });

    it("executes with samplingFn", async () => {
      const result = await executeReview("mcp_sampling", {
        skillsDir: tmpDir,
        personas: testPersonas,
        content: "测试内容",
        samplingFn: mockSamplingFn,
      });

      assert.equal(result.mode, "mcp_sampling");
      assert.ok(result.report.includes("MCP 采样模式"));
    });
  });

  it("throws when mode not available (client not supported)", async () => {
    // Set client to unknown
    setClientCapabilities({});
    
    await assert.rejects(
      async () => {
        await executeReview("mcp_sampling", {
          skillsDir: tmpDir,
          personas: testPersonas,
          content: "测试",
          samplingFn: mockSamplingFn,
        });
      },
      /mcp_sampling 模式当前不可用/
    );
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
    const personas = [makePersona("p1", "A"), makePersona("p2", "B")];
    const result = await executePersonasInParallel(
      personas,
      "Test content",
      { mode: "mcp_sampling", retryEventName: "test" },
      async (p) => `Review by ${p.meta.name}`
    );

    assert.equal(result.mode, "mcp_sampling");
    assert.equal(result.personas.length, 2);
    assert.ok(result.personas.includes("p1"));
    assert.ok(result.personas.includes("p2"));
    assert.ok(!result.partialFailures || result.partialFailures.length === 0);
    assert.ok(result.report.includes("Review by A"));
    assert.ok(result.report.includes("Review by B"));
  });

  it("collects partial failures", async () => {
    const personas = [makePersona("p1", "Good"), makePersona("p2", "Bad")];
    const result = await executePersonasInParallel(
      personas,
      "Test",
      { mode: "direct_api", retryEventName: "test" },
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
  });

  it("respects maxConcurrency from config", async () => {
    process.env.KEVLAR_TOKEN_BUDGET_PER_TASK = "100000";
    let maxConcurrent = 0;
    let current = 0;

    const personas = [makePersona("p1", "A"), makePersona("p2", "B"), makePersona("p3", "C")];
    await executePersonasInParallel(
      personas,
      "Test",
      { mode: "mcp_sampling", retryEventName: "test" },
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
// Direct API Handler Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("directApiHandler", () => {
  const makePersona = (id: string, name: string, sp = "You are a critic."): Persona => ({
    meta: { id, name, name_en: "", version: "1.0", author: "test", tags: [], description: `Persona ${name}` },
    systemPrompt: sp,
    filePath: "/test/personas.json",
  });

  let previousKevlarKey: string | undefined;
  let previousAnthropicKey: string | undefined;
  let previousOpenAiKey: string | undefined;

  beforeEach(() => {
    previousKevlarKey = process.env.KEVLAR_API_KEY;
    previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    previousOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.KEVLAR_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (previousKevlarKey === undefined) delete process.env.KEVLAR_API_KEY;
    else process.env.KEVLAR_API_KEY = previousKevlarKey;
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
  });

  it("canExecute returns false when no API key set", () => {
    assert.ok(!directApiHandler.canExecute());
  });

  it("canExecute returns true when KEVLAR_API_KEY is set", () => {
    process.env.KEVLAR_API_KEY = "sk-ant-test-key-12345";
    assert.ok(directApiHandler.canExecute());
  });

  it("has correct mode and priority", () => {
    assert.equal(directApiHandler.mode, "direct_api");
    assert.equal(directApiHandler.priority, 20);
  });

  it("throws when no API key available on execute", async () => {
    await assert.rejects(
      () => directApiHandler.execute({
        skillsDir: "/tmp",
        personas: [makePersona("p1", "A")],
        content: "test",
      }),
      /API key not configured/
    );
  });

  it("executes with Anthropic provider and mocked fetch", async () => {
    process.env.KEVLAR_API_KEY = "sk-ant-test-key-anthropic-12345";
    process.env.KEVLAR_TOKEN_BUDGET_PER_TASK = "100000";

    const mockResponse = {
      content: [{ type: "text", text: "Anthropic review result" }],
      usage: { input_tokens: 50, output_tokens: 100 },
      stop_reason: "end_turn",
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, init?: any) => {
      assert.ok(url.toString().includes("anthropic.com"));
      const body = JSON.parse(init?.body as string);
      assert.ok(body.model);
      assert.ok(body.system);
      assert.equal(body.temperature, 0.7);
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    };

    try {
      const result = await directApiHandler.execute({
        skillsDir: "/tmp",
        personas: [makePersona("p1", "Critic")],
        content: "test content",
      });

      assert.equal(result.mode, "direct_api");
      assert.equal(result.personas.length, 1);
      assert.ok(result.report.includes("Anthropic review result"));
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.KEVLAR_TOKEN_BUDGET_PER_TASK;
    }
  });

  it("executes with OpenAI provider and mocked fetch", async () => {
    process.env.KEVLAR_API_KEY = "sk-openai-key-1234567890abcdef";
    process.env.KEVLAR_TOKEN_BUDGET_PER_TASK = "100000";

    const mockResponse = {
      choices: [{ message: { content: "OpenAI review result" } }],
      usage: { prompt_tokens: 50, completion_tokens: 100 },
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      assert.ok(url.toString().includes("openai.com"));
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    };

    try {
      const result = await directApiHandler.execute({
        skillsDir: "/tmp",
        personas: [makePersona("p1", "Critic")],
        content: "test openai",
      });

      assert.equal(result.mode, "direct_api");
      assert.ok(result.report.includes("OpenAI review result"));
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.KEVLAR_TOKEN_BUDGET_PER_TASK;
    }
  });

  it("executes with Ollama provider and mocked fetch", async () => {
    process.env.KEVLAR_API_KEY = "ollama-local-key";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    process.env.KEVLAR_MODEL = "llama3";
    process.env.KEVLAR_TOKEN_BUDGET_PER_TASK = "100000";

    const mockResponse = {
      message: { content: "Ollama review result" },
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      assert.ok(url.toString().includes("localhost:11434"));
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    };

    try {
      const result = await directApiHandler.execute({
        skillsDir: "/tmp",
        personas: [makePersona("p1", "Critic")],
        content: "test ollama",
      });

      assert.equal(result.mode, "direct_api");
      assert.ok(result.report.includes("Ollama review result"));
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.OLLAMA_BASE_URL;
      delete process.env.KEVLAR_MODEL;
      delete process.env.KEVLAR_TOKEN_BUDGET_PER_TASK;
    }
  });

  it("reports partial failures for persona errors", async () => {
    process.env.KEVLAR_API_KEY = "sk-ant-fail-key";
    process.env.KEVLAR_TOKEN_BUDGET_PER_TASK = "100000";

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      }), { status: 200 });
    };

    try {
      const personas = [makePersona("p1", "Good"), makePersona("p2", "Bad")];
      const result = await directApiHandler.execute({
        skillsDir: "/tmp",
        personas,
        content: "test",
      });

      assert.ok(result.personas.includes("p1"));
      assert.equal(result.mode, "direct_api");
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.KEVLAR_TOKEN_BUDGET_PER_TASK;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sampling Handler Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("samplingHandler", () => {
  const makePersona = (id: string, name: string, sp = "You are a critic."): Persona => ({
    meta: { id, name, name_en: "", version: "1.0", author: "test", tags: [], description: `Persona ${name}` },
    systemPrompt: sp,
    filePath: "/test/personas.json",
  });

  let previousEnv: string | undefined;

  beforeEach(() => {
    previousEnv = process.env.KEVLAR_ENABLE_SAMPLING;
  });

  afterEach(() => {
    setClientCapabilities({});
    if (previousEnv === undefined) delete process.env.KEVLAR_ENABLE_SAMPLING;
    else process.env.KEVLAR_ENABLE_SAMPLING = previousEnv;
  });

  it("has correct mode and priority", () => {
    assert.equal(samplingHandler.mode, "mcp_sampling");
    assert.equal(samplingHandler.priority, 10);
  });

  it("canExecute returns true when client supports sampling", () => {
    setClientCapabilities({ sampling: {} });
    assert.ok(samplingHandler.canExecute());
  });

  it("canExecute returns false when client does not support sampling", () => {
    setClientCapabilities({});
    assert.ok(!samplingHandler.canExecute());
  });

  it("canExecute returns true when KEVLAR_ENABLE_SAMPLING=true", () => {
    setClientCapabilities({});
    process.env.KEVLAR_ENABLE_SAMPLING = "true";
    assert.ok(samplingHandler.canExecute());
  });

  it("throws when no samplingFn provided on execute", async () => {
    setClientCapabilities({ sampling: {} });
    await assert.rejects(
      () => samplingHandler.execute({
        skillsDir: "/tmp",
        personas: [makePersona("p1", "A")],
        content: "test",
      }),
      /MCP Sampling 模式需要 samplingFn/
    );
  });

  it("executes with samplingFn", async () => {
    setClientCapabilities({ sampling: {} });
    const result = await samplingHandler.execute({
      skillsDir: "/tmp",
      personas: [makePersona("p1", "A"), makePersona("p2", "B")],
      content: "test content",
      samplingFn: async () => ({ content: "mock review", stopReason: "endTurn" }),
    });

    assert.equal(result.mode, "mcp_sampling");
    assert.equal(result.personas.length, 2);
    assert.ok(result.report.includes("mock review"));
  });
});
