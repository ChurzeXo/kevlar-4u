import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { fileURLToPath } from "url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKevlarServer, _resetServerInitializedForTest } from "../server.js";
import {
  TOOL_DESCRIPTION,
  buildFinalRenderInstructions,
  buildOrchestrationFinalizerPrompt,
  buildPreAuditFinalizerPrompt,
  buildCommonRiskRules,
  buildCoreReasoningFramework,
} from "../prompts/reviewWizard.js";
import { SERVER_INSTRUCTIONS } from "../prompts/instructions.js";
import { loadPromptSegments, writePromptSegmentsFile } from "../subscription/promptTemplates.js";
import type { PromptSegments } from "../subscription/promptTypes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REAL_TEMPLATES_DIR = path.resolve(__dirname, "..", "..", "skills", "templates");

let tmpDir: string;
let FREE_SEGMENTS: PromptSegments;

function copyTemplatesTo(tmpDir: string): void {
  const tmpTemplates = path.join(tmpDir, "templates");
  fs.mkdirSync(tmpTemplates, { recursive: true });
  for (const entry of fs.readdirSync(REAL_TEMPLATES_DIR, { withFileTypes: true })) {
    const src = path.join(REAL_TEMPLATES_DIR, entry.name);
    const dest = path.join(tmpTemplates, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

beforeEach(() => {
  _resetServerInitializedForTest();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-refactor-"));
  copyTemplatesTo(tmpDir);
  process.env.KEVLAR_SKILLS_DIR = tmpDir;
  FREE_SEGMENTS = loadPromptSegments("free");
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

    it("SERVER_INSTRUCTIONS contains subagent dispatch conventions", () => {
      assert.ok(SERVER_INSTRUCTIONS.includes("Subagent 并行调度约定"), "Should contain subagent dispatch conventions header");
      assert.ok(SERVER_INSTRUCTIONS.includes("ExecutionBlueprint"), "Should mention ExecutionBlueprint");
      assert.ok(SERVER_INSTRUCTIONS.includes("SEQUENTIAL_FALLBACK"), "Should explain SEQUENTIAL_FALLBACK");
      assert.ok(SERVER_INSTRUCTIONS.includes("禁止自行总结"), "Should forbid summarizing agent results");
    });

    it("SERVER_INSTRUCTIONS does NOT contain rendering protocol", () => {
      assert.ok(!SERVER_INSTRUCTIONS.includes("排版与输出协议"), "Should NOT contain rendering protocol");
      assert.ok(!SERVER_INSTRUCTIONS.includes("Markdown 表格"), "Should NOT contain Markdown table instructions");
      assert.ok(!SERVER_INSTRUCTIONS.includes("一级标题"), "Should NOT contain heading instructions");
    });

    it("MCP server exposes instructions field", async () => {
      const server = await createKevlarServer();
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
      const instructions = buildFinalRenderInstructions(FREE_SEGMENTS);
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
        FREE_SEGMENTS,
      );
      assert.ok(prompt.includes("排版与输出协议"), "Turn 3 prompt should include rendering instructions");
      assert.ok(prompt.includes("一级标题"), "Turn 3 prompt should include heading instructions");
    });

    it("buildPreAuditFinalizerPrompt does NOT include rendering instructions", () => {
      const prompt = buildPreAuditFinalizerPrompt([], undefined, FREE_SEGMENTS);
      assert.ok(!prompt.includes("排版与输出协议"), "Sampling finalizer should NOT include rendering instructions");
    });
  });

  describe("Semantic baseline consistency", () => {
    it("both finalizer prompts use buildCommonRiskRules", () => {
      const orchestrationPrompt = buildOrchestrationFinalizerPrompt(
        "test",
        [],
        [],
        { triggered: [], overallMultiplier: 1.0, levelUpgrades: [] },
        { bareOnly: [], fullOnly: [], stable: [] },
        undefined,
        FREE_SEGMENTS,
      );
      const samplingPrompt = buildPreAuditFinalizerPrompt([], undefined, FREE_SEGMENTS);

      const commonRules = buildCommonRiskRules();
      assert.ok(orchestrationPrompt.includes(commonRules), "Orchestration finalizer should include common risk rules");
      assert.ok(samplingPrompt.includes(commonRules), "Sampling finalizer should include common risk rules");
    });

    it("Sampling finalizer includes core reasoning framework for semantic parity", () => {
      const samplingPrompt = buildPreAuditFinalizerPrompt([], undefined, FREE_SEGMENTS);
      const coreFramework = buildCoreReasoningFramework();
      assert.ok(samplingPrompt.includes(coreFramework), "Sampling finalizer should include core reasoning framework");
    });
  });
});
