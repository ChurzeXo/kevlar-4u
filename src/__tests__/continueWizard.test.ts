import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { reviewContentWizardContinueModule } from "../tools/continueWizardTool.js";
import { isValidSessionId } from "../utils/sessionId.js";
import { rejected, degraded, progress, formatStatus, formatStatusMessage, parseStatus } from "../execution/continuationStatus.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSessionId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function writeStateFile(tmpDir: string, sessionId: string, state: Record<string, unknown>) {
  const statePath = path.join(tmpDir, `${sessionId}_review_wizard.json`);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

function statePath(tmpDir: string, sessionId: string): string {
  return path.join(tmpDir, `${sessionId}_review_wizard.json`);
}

// ── Base state used across tests ──────────────────────────────────────────────

function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "test-sid",
    step: "initiated",
    revision: 1,
    content: "测试内容",
    activeContinuation: {
      continuationId: "cont-123",
      checkpoint: "initiated",
      expiresAt: Date.now() + 600000,
      retryCount: 0,
    },
    ...overrides,
  };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let tmpDir: string;
let skillsDir: string;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-continue-wizard-"));
  tmpDir = path.join(skillsDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    skillsDir,
    tmpDir,
    resolveSamplingFn: () => undefined,
    sendProgress: undefined,
    strategyProvider: {
      getEntitlement: async () => "free" as const,
      getReviewPlan: async () => ({
        tier: "free" as const,
        steps: ["orchestration_step0"],
        visibility: { preAuditDetails: "hidden" as const, upgradePrompt: "after_rst" as const },
        strategySessionId: "test-session",
        strategyVersion: "1.0",
        strategyHash: "abc123",
      }),
      getWeights: async () => ({ rules: [] }),
      getSynergyRules: () => [],
      getIsolationMode: () => "process" as const,
    },
    ...overrides,
  };
}

function textOf(result: any): string {
  return result.content?.map((c: any) => c.text).join("\n") ?? "";
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("reviewContentWizardContinue — input validation", () => {
  it("rejects missing sessionId", async () => {
    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({});
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("缺少 sessionId"));
  });

  it("rejects empty string sessionId", async () => {
    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({ sessionId: "" });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("缺少 sessionId"));
  });

  it("rejects non-string sessionId", async () => {
    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({ sessionId: 12345 });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("缺少 sessionId"));
  });

  it("rejects invalid sessionId format", async () => {
    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({ sessionId: "bad!@#id" });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("无效的 sessionId 格式"));
  });

  it("rejects sessionId that is too long", async () => {
    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const longId = "a".repeat(129);
    const result = await handler({ sessionId: longId });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("无效的 sessionId 格式"));
  });

  it("accepts valid sessionId with lowercase alphanumeric and dash only", () => {
    assert.equal(isValidSessionId("valid-session-123"), true);
  });

  it("accepts undefined args (throws)", async () => {
    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    await assert.rejects(
      () => handler(undefined),
      /需要提供参数/
    );
  });
});

describe("reviewContentWizardContinue — state file handling", () => {
  it("returns error when state file does not exist", async () => {
    const sid = makeSessionId();
    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "initiated",
      expectedRevision: 1,
      continuationId: "cont-123",
    });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("未找到此 session 的状态文件"));
  });
});

describe("reviewContentWizardContinue — standard continuation checks (non-subagent)", () => {
  it("rejects when revision does not match", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, baseState({ sessionId: sid, revision: 5 }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "initiated",
      expectedRevision: 3,
      continuationId: "cont-123",
    });

    assert.equal(result.isError, true);
    const t = textOf(result);
    assert.ok(t.includes("Stale Continuation"));
    assert.ok(t.includes("预期版本：3"));
  });

  it("rejects when no active continuation exists", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, baseState({
      sessionId: sid,
      activeContinuation: undefined,
    }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "initiated",
      expectedRevision: 1,
      continuationId: "cont-123",
    });

    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("没有活动的延续请求"));
  });

  it("rejects when continuationId does not match", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, baseState({ sessionId: sid }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "initiated",
      expectedRevision: 1,
      continuationId: "wrong-cont-id",
    });

    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("Continuation ID 不匹配"));
    assert.ok(textOf(result).includes("cont-123")); // expected
    assert.ok(textOf(result).includes("wrong-cont-id")); // received
  });

  it("rejects when checkpoint does not match", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, baseState({
      sessionId: sid,
      activeContinuation: {
        continuationId: "cont-123",
        checkpoint: "preaudit_started",
        expiresAt: Date.now() + 600000,
        retryCount: 0,
      },
    }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "step0_completed",
      expectedRevision: 1,
      continuationId: "cont-123",
    });

    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("Checkpoint 不匹配"));
  });

  it("falls back to orchestration when continuation has expired", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, baseState({
      sessionId: sid,
      activeContinuation: {
        continuationId: "cont-123",
        checkpoint: "initiated",
        expiresAt: Date.now() - 60000, // expired 1 min ago
        retryCount: 0,
      },
    }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "initiated",
      expectedRevision: 1,
      continuationId: "cont-123",
    });

    assert.equal(result.isError, undefined); // gracefully degraded
    assert.ok(textOf(result).includes("已过期"));
    assert.ok(textOf(result).includes("已自动降级"));
  });
});

describe("reviewContentWizardContinue — retry limit exceeded", () => {
  it("falls back to orchestration after 3 retries instead of deleting state", async () => {
    const sid = makeSessionId();
    const sp = statePath(tmpDir, sid);
    writeStateFile(tmpDir, sid, baseState({
      sessionId: sid,
      activeContinuation: {
        continuationId: "cont-123",
        checkpoint: "initiated",
        expiresAt: Date.now() + 600000,
        retryCount: 3, // this is the 4th attempt (3 → incremented to 4 > MAX=3)
      },
    }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "initiated",
      expectedRevision: 1,
      continuationId: "cont-123",
    });

    assert.equal(result.isError, undefined); // no error — gracefully degraded
    assert.ok(textOf(result).includes("已达最大重试次数"));
    assert.ok(textOf(result).includes("已自动降级"), "should mention auto-degrade");
    assert.ok(fs.existsSync(sp), "state file should persist after L3 fallback");
  });

  it("does NOT delete state file or return error on 2nd retry (below limit)", async () => {
    const sid = makeSessionId();
    const sp = statePath(tmpDir, sid);
    writeStateFile(tmpDir, sid, baseState({
      sessionId: sid,
      activeContinuation: {
        continuationId: "cont-123",
        checkpoint: "initiated",
        expiresAt: Date.now() + 600000,
        retryCount: 1, // this is the 2nd attempt (1 → incremented to 2, still ≤ 3)
      },
    }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "initiated",
      expectedRevision: 1,
      continuationId: "cont-123",
    });

    // Should NOT be an error for retry limit — state file still exists
    assert.ok(fs.existsSync(sp), "state file should still exist");

    // The continuation was accepted (state.revision incremented, activeContinuation cleared
    // in lines 280-281), then handleReviewContentWizard may set up a new activeContinuation.
    const updatedState = JSON.parse(fs.readFileSync(sp, "utf-8"));
    assert.ok(updatedState.revision >= 2, "revision should be incremented at least once");
    // The old activeContinuation (cont-123) should be gone
    const ac = updatedState.activeContinuation;
    assert.ok(!ac || ac.continuationId !== "cont-123",
      "old continuationId should be replaced or cleared");
    // Should not be a max-retries error
    const t = textOf(result);
    assert.ok(!t.includes("已达最大重试次数"), "should not trigger max retry error");
  });
});

describe("reviewContentWizardContinue — validateContinuationGate integration", () => {
  it("returns error when validateContinuationGate throws stale_revision", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, baseState({
      sessionId: sid,
      step: "waitingForSubagentAudit",
      revision: 5, // different from expectedRevision
    }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "step0_completed",
      expectedRevision: 1,
      continuationId: "cont-123",
    });

    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("门禁验证失败"));
  });

  it("returns error when validateContinuationGate throws id_mismatch", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, baseState({
      sessionId: sid,
      step: "waitingForSubagentAudit",
      revision: 1,
      activeContinuation: {
        continuationId: "different-cont",
        checkpoint: "step0_completed",
        expiresAt: Date.now() + 600000,
        retryCount: 0,
      },
    }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "preaudit_completed",
      expectedRevision: 1,
      continuationId: "wrong-cont",
    });

    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("门禁验证失败"));
  });

  it("returns orchestration fallback prompt when validation status is invalid (waitingForSubagentAudit)", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, baseState({
      sessionId: sid,
      step: "waitingForSubagentAudit",
      revision: 1,
      blueprint: {
        contexts: [{ id: "context-1", description: "test agent" }],
        aggregation: "union",
        outputSchema: {},
      },
      activeContinuation: {
        continuationId: "cont-456",
        checkpoint: "step0_completed",
        expiresAt: Date.now() + 600000,
        retryCount: 0,
      },
      orchestrationPreAuditContext: null,
    }));

    // Pass receipt=null to trigger schema validation failure → invalid status
    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "step0_completed",
      expectedRevision: 1,
      continuationId: "cont-456",
      receipt: null,
    });

    assert.equal(result.isError, undefined);
    // Should return fallback orchestration prompt
    const t = textOf(result);
    assert.ok(t.includes("会话 ID"), "should include session info");
    assert.ok(t.includes(sid), "should show the session id");
  });

  it("returns persona audit abort prompt when validation is invalid (waitingForPersonaAudit)", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, baseState({
      sessionId: sid,
      step: "waitingForPersonaAudit",
      revision: 1,
      blueprint: {
        contexts: [{ id: "context-1", description: "test agent" }],
        aggregation: "union",
        outputSchema: {},
      },
      activeContinuation: {
        continuationId: "cont-789",
        checkpoint: "persona_audit_started",
        expiresAt: Date.now() + 600000,
        retryCount: 0,
      },
      orchestrationPreAuditContext: null,
    }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "persona_audit_started",
      expectedRevision: 1,
      continuationId: "cont-789",
      receipt: null,
    });

    // fallbackToStandardOrchestration changes state.step from waitingForPersonaAudit
    // to waitingForOrchestrationStep0 (when no step0Result exists), so the persona
    // error branch at line 131 is skipped. Instead, we get an orchestration fallback.
    // The result is a non-error prompt telling host AI to run standard orchestration.
    assert.ok(!result.isError, "should not be an error — orchestration fallback returned");
    const t = textOf(result);
    assert.ok(t.includes("已自动切换为标准宿主编排模式"), "should indicate orchestration fallback");
    assert.ok(t.includes(sid), "should include session id");
  });

  it("accepts continuation when gate returns valid status", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, baseState({
      sessionId: sid,
      step: "waitingForSubagentAudit",
      revision: 1,
      blueprint: {
        contexts: [{ id: "context-1", description: "test agent" }],
        aggregation: "union",
        outputSchema: {
          type: "object",
          properties: { level: { type: "string" } },
        },
      },
      activeContinuation: {
        continuationId: "cont-accept",
        checkpoint: "step0_completed",
        expiresAt: Date.now() + 600000,
        retryCount: 0,
      },
    }));

    // Pass a receipt conforming to kevlar.blueprint/v1 protocol
    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "step0_completed",
      expectedRevision: 1,
      continuationId: "cont-accept",
      receipt: {
        protocol: "kevlar.blueprint/v1",
        contexts: [
          {
            id: "context-1",
            status: "completed",
            output: {
              findings: [
                { id: "f1", suggestedLevel: "🟡", description: "test" },
              ],
            },
          },
        ],
        aggregation: {
          dimensions: [{ id: "context-1", level: "🟡", description: "test" }],
          summary: "All agents completed",
        },
      },
    });

    // The continuation should be accepted — state file updated
    const updatedState = JSON.parse(fs.readFileSync(statePath(tmpDir, sid), "utf-8"));
    // After acceptance: old continuation cleared, revision incremented
    assert.ok(updatedState.revision >= 2, "revision should be incremented");
    const ac = updatedState.activeContinuation;
    assert.ok(!ac || ac.continuationId !== "cont-accept",
      "old continuation should be cleared");
  });
});

describe("reviewContentWizardContinue — edge cases", () => {
  it("handles revision being undefined in state (defaults to 1)", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, baseState({
      sessionId: sid,
      revision: undefined, // missing revision
    }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "initiated",
      expectedRevision: 1, // now matches default of 1
      continuationId: "cont-123",
    });

    // Should NOT fail on stale revision (defaults to 1)
    assert.ok(!result.isError || !textOf(result).includes("Stale Continuation"));
  });

  it("handles invalid JSON in state file gracefully", async () => {
    const sid = makeSessionId();
    const sp = statePath(tmpDir, sid);
    fs.writeFileSync(sp, "not-valid-json{{{", "utf-8");

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    // Handler wraps JSON.parse in try/catch → returns isError result, not throw
    const result = await handler({
      sessionId: sid,
      checkpoint: "initiated",
      expectedRevision: 1,
      continuationId: "cont-123",
    });

    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("未找到此 session 的状态文件"));
  });

  it("parses result as JSON receipt when no explicit receipt provided", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, baseState({
      sessionId: sid,
      step: "waitingForSubagentAudit",
      revision: 1,
      blueprint: {
        contexts: [{ id: "context-1", description: "test agent" }],
        aggregation: "union",
        outputSchema: {
          type: "object",
          properties: { level: { type: "string" } },
        },
      },
      activeContinuation: {
        continuationId: "cont-result-parse",
        checkpoint: "step0_completed",
        expiresAt: Date.now() + 600000,
        retryCount: 0,
      },
    }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "step0_completed",
      expectedRevision: 1,
      continuationId: "cont-result-parse",
      result: JSON.stringify({
        protocol: "kevlar.blueprint/v1",
        contexts: [
          {
            id: "context-1",
            status: "completed",
            output: {
              findings: [
                { id: "f1", suggestedLevel: "🔴", description: "danger" },
              ],
            },
          },
        ],
        aggregation: {
          dimensions: [{ id: "context-1", level: "🔴", description: "danger" }],
          summary: "parsed from result",
        },
      }),
    });

    // Should accept the parsed receipt
    const updatedState = JSON.parse(fs.readFileSync(statePath(tmpDir, sid), "utf-8"));
    assert.ok(updatedState.revision >= 2, "revision should be incremented");
    const ac = updatedState.activeContinuation;
    assert.ok(!ac || ac.continuationId !== "cont-result-parse",
      "old continuation should be cleared");
  });

  it("handles result that is not valid JSON gracefully (receipt becomes null)", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, baseState({
      sessionId: sid,
      step: "waitingForSubagentAudit",
      revision: 1,
      blueprint: {
        contexts: [{ id: "context-1", description: "test agent" }],
        aggregation: "union",
        outputSchema: {},
      },
      activeContinuation: {
        continuationId: "cont-bad-json",
        checkpoint: "step0_completed",
        expiresAt: Date.now() + 600000,
        retryCount: 0,
      },
    }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "step0_completed",
      expectedRevision: 1,
      continuationId: "cont-bad-json",
      result: "this is a natural language result, not JSON",
    });

    // receipt becomes null, which triggers invalid validation
    // → fallback orchestration for waitingForSubagentAudit
    const t = textOf(result);
    assert.ok(!result.isError || t.includes("会话 ID"), "should return fallback prompt");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slot-based per-agent submission tests (§4.5)
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewContentWizardContinue — slot-based agent submission", () => {
  function proSlotState(sessionId: string, overrides: Record<string, unknown> = {}) {
    const contextIds = ["context-1", "agent-2"];
    const tier = (overrides.tier as string) ?? "pro";
    return baseState({
      sessionId,
      step: "waitingForSubagentAudit",
      revision: 1,
      tier,
      blueprint: {
        protocol: "kevlar.blueprint/v1",
        contexts: contextIds.map((id) => ({ id, role: "safety_reviewer" })),
        continuation: {
          contextSlots: {
            total: 2,
            contextIds,
            allowPartialSubmit: tier === "pro",
          },
        },
      },
      activeContinuation: {
        continuationId: `cont-slot-${sessionId}`,
        checkpoint: "preaudit_completed",
        expiresAt: Date.now() + 600000,
        retryCount: 0,
      },
      ...overrides,
    });
  }

  function proSlotDeps() {
    return makeDeps({
      strategyProvider: {
        getEntitlement: async () => "pro" as const,
        getReviewPlan: async () => ({
          tier: "pro" as const,
          steps: ["system_audit"],
          visibility: { preAuditDetails: "full" as const, upgradePrompt: "disabled" as const },
          strategySessionId: "test-session",
          strategyVersion: "1.0",
          strategyHash: "abc123",
        }),
        getWeights: async () => ({ rules: [] }),
        getSynergyRules: () => [],
        getIsolationMode: () => "process" as const,
      },
    });
  }

  it("rejects contextId for Free tier", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, proSlotState(sid, { tier: "free" }));

    const handler = reviewContentWizardContinueModule.handler(makeDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "preaudit_completed",
      expectedRevision: 1,
      continuationId: `cont-slot-${sid}`,
      contextId: "context-1",
      receipt: { contextId: "context-1", status: "completed", output: { findings: [{ keyword: "risky" }] } },
    });

    assert.ok(result.isError);
    assert.ok(textOf(result).includes("逐 context 提交未启用"));
  });

  it("rejects invalid continuationId format in slot path", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, proSlotState(sid));

    const handler = reviewContentWizardContinueModule.handler(proSlotDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "preaudit_completed",
      expectedRevision: 1,
      continuationId: "BAD!ID",
      contextId: "context-1",
      receipt: { contextId: "context-1", status: "completed", output: { findings: [] } },
    });

    assert.ok(result.isError);
    assert.ok(textOf(result).includes("格式不合法"));
  });

  it("rejects invalid contextId format", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, proSlotState(sid));

    const handler = reviewContentWizardContinueModule.handler(proSlotDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "preaudit_completed",
      expectedRevision: 1,
      continuationId: `cont-slot-${sid}`,
      contextId: "bad agent!",
      receipt: { contextId: "bad agent!", status: "completed", output: { findings: [] } },
    });

    assert.ok(result.isError);
    assert.ok(textOf(result).includes("contextId 格式不合法"));
  });

  it("rejects unknown contextId not in blueprint", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, proSlotState(sid));

    const handler = reviewContentWizardContinueModule.handler(proSlotDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "preaudit_completed",
      expectedRevision: 1,
      continuationId: `cont-slot-${sid}`,
      contextId: "agent-99",
      receipt: { contextId: "agent-99", status: "completed", output: { findings: [] } },
    });

    assert.ok(result.isError);
    assert.ok(textOf(result).includes("未知的 contextId"));
  });

  it("accepts first slot and returns progress with expectedRevision", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, proSlotState(sid));

    const handler = reviewContentWizardContinueModule.handler(proSlotDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "preaudit_completed",
      expectedRevision: 1,
      continuationId: `cont-slot-${sid}`,
      contextId: "context-1",
      receipt: { contextId: "context-1", status: "completed", output: { findings: [{ keyword: "risky" }] } },
    });

    assert.equal(result.isError, undefined); // not an error
    const t = textOf(result);
    assert.ok(t.includes("已收到 context"), "should confirm receipt");
    assert.ok(t.includes("expectedRevision"), "should include expectedRevision for next call");

    // Verify state was updated: revision incremented, slot populated
    const s = JSON.parse(fs.readFileSync(statePath(tmpDir, sid), "utf-8"));
    assert.ok(s.revision >= 2, "revision should be incremented");
    assert.ok(s.contextSlots, "contextSlots should exist");
    assert.ok(s.contextSlots.received["context-1"], "slot should contain agent-1 result");
    assert.equal(s.contextSlots.received["context-1"].status, "completed");
  });

  it("allows overwrite on repeated slot submission", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, {
      ...proSlotState(sid),
      revision: 2,
      contextSlots: {
        total: 2,
        received: {
          "context-1": {
            contextId: "context-1",
            status: "completed",
            submittedAt: Date.now() - 10000,
            output: { findings: [{ keyword: "old" }] },
          },
        },
      },
    });

    const handler = reviewContentWizardContinueModule.handler(proSlotDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "preaudit_completed",
      expectedRevision: 2,
      continuationId: `cont-slot-${sid}`,
      contextId: "context-1",
      receipt: { contextId: "context-1", status: "completed", output: { findings: [{ keyword: "new" }] },
      },
    });

    assert.equal(result.isError, undefined);
    assert.ok(textOf(result).includes("覆盖先前提交"), "should indicate overwrite");
  });

  it("accepts agents with status: failed (not used in aggregation)", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, proSlotState(sid));

    const handler = reviewContentWizardContinueModule.handler(proSlotDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "preaudit_completed",
      expectedRevision: 1,
      continuationId: `cont-slot-${sid}`,
      contextId: "context-1",
      receipt: { contextId: "context-1", status: "failed", output: { findings: [] } },
    });

    assert.equal(result.isError, undefined);
    const s = JSON.parse(fs.readFileSync(statePath(tmpDir, sid), "utf-8"));
    assert.equal(s.contextSlots.received["context-1"].status, "failed");
  });

  it("returns error when all agents failed (zero completed)", async () => {
    const sid = makeSessionId();
    // Pre-populate agent-1 as failed, submit agent-2 as failed → zero completed
    writeStateFile(tmpDir, sid, proSlotState(sid, {
      contextSlots: {
        total: 2,
        received: {
          "context-1": {
            contextId: "context-1",
            status: "failed",
            submittedAt: Date.now() - 10000,
            output: { findings: [] },
          },
        },
      },
      revision: 2,
    }));

    const handler = reviewContentWizardContinueModule.handler(proSlotDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "preaudit_completed",
      expectedRevision: 2,
      continuationId: `cont-slot-${sid}`,
      contextId: "agent-2",
      receipt: { contextId: "agent-2", status: "failed", output: { findings: [] } },
    });

    assert.ok(result.isError);
    assert.ok(textOf(result).includes("全部 context 执行失败"), "should report all contexts failed");
  });

  it("triggers partial auto-finalize when continuation expired with partial slots", async () => {
    const sid = makeSessionId();
    writeStateFile(tmpDir, sid, proSlotState(sid, {
      contextSlots: {
        total: 2,
        received: {
          "context-1": {
            contextId: "context-1",
            status: "completed",
            submittedAt: Date.now() - 10000,
            output: { findings: [{ keyword: "risky" }] },
          },
        },
      },
      revision: 2,
      activeContinuation: {
        continuationId: `cont-slot-${sid}`,
        checkpoint: "preaudit_completed",
        expiresAt: Date.now() - 1, // already expired
        retryCount: 0,
      },
    }));

    const handler = reviewContentWizardContinueModule.handler(proSlotDeps());
    const result = await handler({
      sessionId: sid,
      checkpoint: "preaudit_completed",
      expectedRevision: 2,
      continuationId: `cont-slot-${sid}`,
      contextId: "agent-2",
      receipt: { contextId: "agent-2", status: "completed", output: { findings: [] } },
    });

    // Should auto-finalize with partial results (not error)
    assert.equal(result.isError, undefined);
    const s = JSON.parse(fs.readFileSync(statePath(tmpDir, sid), "utf-8"));
    // After finalizeSlots, state should have incremented revision and cleared continuation
    assert.ok(s.revision >= 3, "revision should be incremented after finalize");
    assert.ok(!s.activeContinuation, "continuation should be cleared after finalize");
  });
});

// ── Structured Continuation Status protocol tests ───────────────────────────

describe("ContinuationStatus — structured status protocol", () => {
  it("formatStatus embeds JSON inside KEVLAR_STATUS markers", () => {
    const status = rejected("stale_revision", { currentRevision: 5, expectedRevision: 3 });
    const wire = formatStatus(status);
    assert.ok(wire.startsWith("[KEVLAR_STATUS]\n"));
    assert.ok(wire.includes("[/KEVLAR_STATUS]"));
    assert.ok(wire.includes('"stale_revision"'));
  });

  it("parseStatus extracts structured status from wire format", () => {
    const original = rejected("continuation_id_mismatch", { expected: "cont-1", received: "cont-2" });
    const wire = formatStatusMessage(original, "Human message");
    const parsed = parseStatus(wire);
    assert.equal(parsed?.status, "rejected");
    assert.equal(parsed?.reason, "continuation_id_mismatch");
    assert.equal(parsed?.retry, false);
    assert.deepEqual(parsed?.details, { expected: "cont-1", received: "cont-2" });
  });

  it("parseStatus returns null when no marker present", () => {
    assert.equal(parseStatus("plain text"), null);
  });

  it("degraded status includes retry: false", () => {
    const s = degraded("continuation_expired", { sessionId: "s1" });
    assert.equal(s.status, "degraded");
    assert.equal(s.retry, false);
  });

  it("progress status includes retry: true", () => {
    const s = progress("slot_received", { contextId: "a1", remaining: 2 });
    assert.equal(s.status, "progress");
    assert.equal(s.retry, true);
  });

  it("formatStatusMessage includes human message after structured envelope", () => {
    const msg = formatStatusMessage(rejected("no_active_continuation"), "❌ 此会话没有活动的延续请求。");
    assert.ok(msg.includes("[KEVLAR_STATUS]"));
    assert.ok(msg.includes("[/KEVLAR_STATUS]"));
    assert.ok(msg.includes("此会话没有活动的延续请求。"));
  });
});
