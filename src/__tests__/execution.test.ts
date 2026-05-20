import { describe, it, beforeEach, afterEach, mock } from "node:test";
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
import { setClientInfo, isSamplingSupported, getSamplingClientList } from "../execution/client.js";
import { setConfigPath, readConfig, updateConfig, isValidMode, isValidConcurrency } from "../execution/config.js";
import { RateLimiter, withRetry, isRetryableError } from "../execution/limiter.js";
import { ResultAggregator, generateAggregatedReport, estimateTokenCost, checkBudget } from "../execution/aggregator.js";
import { acquireReviewLock, releaseReviewLock, getReviewLock, isLocked } from "../execution/lock.js";
import { executeReview, loadPersonasForReview, validatePersonaFields } from "../execution/index.js";

let tmpDir: string;

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
        filePath: "/test/persona.md",
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
  it("returns true for claude-ai", () => {
    assert.ok(isSamplingSupported("claude-ai"));
    assert.ok(isSamplingSupported("Claude-AI"));
  });

  it("returns false for unknown clients", () => {
    assert.ok(!isSamplingSupported("unknown-client"));
  });

  it("returns false when no client info is set", () => {
    setClientInfo("unknown");
    assert.ok(!isSamplingSupported());
  });
});

describe("getSamplingClientList", () => {
  it("returns an array with claude-ai", () => {
    const list = getSamplingClientList();
    assert.ok(Array.isArray(list));
    assert.ok(list.includes("claude-ai"));
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
    // (1000/3) + 3*10000 = 333 + 30000 = 30333
    assert.equal(cost, 30333);
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
    assert.ok(lock!.startedAt > 0);
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
      filePath: "/test/persona.md",
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
    assert.ok(result.report.includes("🛡️ Kevlar 压力测试任务派发"));
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
      setClientInfo("claude-ai");
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
    setClientInfo("unknown-client");
    
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
  it("bypasses validation for built-in personas", () => {
    const builtin: any = {
      meta: { author: "kevlar-core", name: "Built-in" },
      systemPrompt: "You are a test.",
    };
    assert.doesNotThrow(() => validatePersonaFields(builtin));
  });

  it("succeeds for valid custom persona", () => {
    const validCustom: any = {
      meta: { author: "user", name: "Custom", description: "活跃于平台" },
      systemPrompt: "性格特质：温和。盲区：无。",
    };
    assert.doesNotThrow(() => validatePersonaFields(validCustom));
  });

  it("throws for custom persona missing platform", () => {
    const invalid: any = {
      meta: { author: "user", name: "Custom" },
      systemPrompt: "性格特质：温和。盲区：无。",
    };
    assert.throws(() => validatePersonaFields(invalid), /未通过字段校验/);
  });

  it("throws for custom persona missing traits", () => {
    const invalid: any = {
      meta: { author: "user", name: "Custom", description: "活跃于平台" },
      systemPrompt: "盲区：无。",
    };
    assert.throws(() => validatePersonaFields(invalid), /未通过字段校验/);
  });

  it("throws for custom persona missing blind spot", () => {
    const invalid: any = {
      meta: { author: "user", name: "Custom", description: "活跃于平台" },
      systemPrompt: "性格特质：温和。",
    };
    assert.throws(() => validatePersonaFields(invalid), /未通过字段校验/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadPersonasForReview Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadPersonasForReview", () => {
  beforeEach(async () => {
    // Create a test persona file in tmpDir
    const personaPath = path.join(tmpDir, "test_persona.md");
    fs.writeFileSync(personaPath, [
      "---",
      "id: test_persona",
      "name: 测试人设",
      "name_en: Test",
      "version: 1.0.0",
      "author: kevlar-core",
      "tags:",
      "  - test",
      "description: A test persona",
      "---",
      "You are a test.",
    ].join("\n"), "utf-8");
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
