import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKevlarServer } from "../server.js";
import {
  TOOL_DESCRIPTION,
  buildFinalRenderInstructions,
  buildOrchestrationFinalizerPrompt,
  buildPreAuditFinalizerPrompt,
  buildCommonRiskRules,
  buildCoreReasoningFramework,
} from "../prompts/reviewWizard.js";
import { SERVER_INSTRUCTIONS } from "../prompts/instructions.js";
import { DEFAULT_FREE_PROMPTS } from "../subscription/promptTypes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-refactor-"));
  process.env.KEVLAR_SKILLS_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.KEVLAR_SKILLS_DIR;
});

describe("Refactoring: Instructions & Prompt Decoupling", () => {
  describe("Server Instructions", () => {
    it("SERVER_INSTRUCTIONS contains core red lines", () => {
      assert.ok(SERVER_INSTRUCTIONS.includes("禁止好心泛滥"), "Should contain red line: no good-hearted suggestions");
      assert.ok(SERVER_INSTRUCTIONS.includes("禁止伪合规引导"), "Should contain red line: no pseudo-compliance");
      assert.ok(SERVER_INSTRUCTIONS.includes("保持冷酷"), "Should contain red line: stay cold");
    });

    it("SERVER_INSTRUCTIONS does NOT contain rendering protocol", () => {
      assert.ok(!SERVER_INSTRUCTIONS.includes("排版与输出协议"), "Should NOT contain rendering protocol");
      assert.ok(!SERVER_INSTRUCTIONS.includes("Markdown 表格"), "Should NOT contain Markdown table instructions");
      assert.ok(!SERVER_INSTRUCTIONS.includes("一级标题"), "Should NOT contain heading instructions");
    });

    it("MCP server exposes instructions field", async () => {
      const server = createKevlarServer();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      const client = new Client(
        { name: "kevlar-refactor-test", version: "1.0.0" },
        { capabilities: {} }
      );

      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);

      try {
        // After connection, server instructions should be available
        const instructions = (client as any)._instructions;
        assert.ok(instructions, "Client should have instructions from server");
        assert.ok(instructions.includes("禁止好心泛滥"), "Instructions should contain red lines");
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe("TOOL_DESCRIPTION simplification", () => {
    it("TOOL_DESCRIPTION does NOT contain rendering protocol", () => {
      assert.ok(!TOOL_DESCRIPTION.includes("排版与输出协议"), "Should NOT contain rendering protocol");
      assert.ok(!TOOL_DESCRIPTION.includes("Markdown 表格"), "Should NOT contain Markdown table instructions");
      assert.ok(!TOOL_DESCRIPTION.includes("一级标题"), "Should NOT contain heading instructions");
    });

    it("TOOL_DESCRIPTION does NOT contain red lines", () => {
      assert.ok(!TOOL_DESCRIPTION.includes("禁止好心泛滥"), "Should NOT contain red lines");
      assert.ok(!TOOL_DESCRIPTION.includes("绝对红线"), "Should NOT contain absolute red lines section");
    });

    it("TOOL_DESCRIPTION still contains core functionality", () => {
      assert.ok(TOOL_DESCRIPTION.includes("内容风险评测向导工具"), "Should contain tool name");
      assert.ok(TOOL_DESCRIPTION.includes("触发时机"), "Should contain trigger timing");
      assert.ok(TOOL_DESCRIPTION.includes("接口契约"), "Should contain interface contract");
      assert.ok(TOOL_DESCRIPTION.includes("核心控制生命周期"), "Should contain lifecycle");
    });
  });

  describe("Rendering instructions isolation", () => {
    it("buildFinalRenderInstructions contains full rendering protocol", () => {
      const instructions = buildFinalRenderInstructions(DEFAULT_FREE_PROMPTS);
      assert.ok(instructions.includes("排版与输出协议"), "Should contain rendering protocol title");
      assert.ok(instructions.includes("一级标题"), "Should contain heading instructions");
      assert.ok(instructions.includes("Markdown 表格"), "Should contain table instructions");
      assert.ok(instructions.includes("深度推演"), "Should contain deep reasoning instructions");
      assert.ok(instructions.includes("尾部状态询问"), "Should contain footer instructions");
    });

    it("buildOrchestrationFinalizerPrompt includes rendering instructions", () => {
      const prompt = buildOrchestrationFinalizerPrompt(
        "test content",
        [],
        [],
        { triggered: [], overallMultiplier: 1.0, levelUpgrades: [] },
        { bareOnly: [], fullOnly: [], stable: [] },
        undefined,
        DEFAULT_FREE_PROMPTS,
      );
      assert.ok(prompt.includes("排版与输出协议"), "Turn 3 prompt should include rendering instructions");
      assert.ok(prompt.includes("一级标题"), "Turn 3 prompt should include heading instructions");
    });

    it("buildPreAuditFinalizerPrompt does NOT include rendering instructions", () => {
      const prompt = buildPreAuditFinalizerPrompt([], undefined, DEFAULT_FREE_PROMPTS);
      assert.ok(!prompt.includes("排版与输出协议"), "Direct API/Sampling finalizer should NOT include rendering instructions");
    });
  });

  describe("Semantic baseline consistency", () => {
    it("both finalizer prompts use buildCommonRiskRules", () => {
      const orchestrationPrompt = buildOrchestrationFinalizerPrompt(
        "test",
        [],
        [],
        { triggered: [], overallMultiplier: 1.0, levelUpgrades: [] },
        { bareOnly: [], fullOnly: [], stable: [] }
      );
      const directApiPrompt = buildPreAuditFinalizerPrompt([]);

      const commonRules = buildCommonRiskRules();
      assert.ok(orchestrationPrompt.includes(commonRules), "Orchestration finalizer should include common risk rules");
      assert.ok(directApiPrompt.includes(commonRules), "Direct API/Sampling finalizer should include common risk rules");
    });

    it("Direct API/Sampling finalizer includes core reasoning framework for semantic parity", () => {
      const directApiPrompt = buildPreAuditFinalizerPrompt([]);
      const coreFramework = buildCoreReasoningFramework();
      assert.ok(directApiPrompt.includes(coreFramework), "Direct API/Sampling finalizer should include core reasoning framework");
    });
  });
});
