import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { fileURLToPath } from "url";

import {
  buildFinalRenderInstructions,
  buildOrchestrationFinalizerPrompt,
} from "../prompts/reviewWizard.js";
import { generateAggregatedReport } from "../execution/aggregator.js";
import { loadPromptSegments } from "../subscription/promptTemplates.js";
import type { PromptSegments } from "../subscription/promptTypes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REAL_TEMPLATES_DIR = path.resolve(__dirname, "..", "..", "skills", "templates");

let tmpDir: string;
let FREE_SEGMENTS: PromptSegments;
let PRO_SEGMENTS: PromptSegments;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-tier-"));
  const tmpTemplates = path.join(tmpDir, "templates");
  fs.mkdirSync(tmpTemplates, { recursive: true });
  for (const file of fs.readdirSync(REAL_TEMPLATES_DIR)) {
    fs.copyFileSync(path.join(REAL_TEMPLATES_DIR, file), path.join(tmpTemplates, file));
  }
  process.env.KEVLAR_SKILLS_DIR = tmpDir;
  FREE_SEGMENTS = loadPromptSegments("free");
  // Pro segments come from server; for tests, construct expected shape manually
  PRO_SEGMENTS = loadPromptSegments("free"); // fallback — real Pro data from server
  if (PRO_SEGMENTS.precedentLockedMessage) {
    PRO_SEGMENTS = { ...PRO_SEGMENTS, precedentLockedMessage: "" };
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.KEVLAR_SKILLS_DIR;
  delete process.env.KEVLAR_TIER;
  delete process.env.KEVLAR_PRO_TOKEN;
});

describe("Tier Split: Free vs Pro Precedents Gating", () => {
  describe("buildFinalRenderInstructions", () => {
    it("renders Free-tier instructions when given Pro segments (server fallback)", () => {
      const instructions = buildFinalRenderInstructions(PRO_SEGMENTS);
      // Pro segments from server would have different instructions;
      // without server, they fall back to Free behavior
      assert.ok(instructions.includes("🔒 类似先例已锁定"), "Free-tier lock message should appear when Pro server unavailable");
    });

    it("renders locked message instructions when given Free segments", () => {
      const instructions = buildFinalRenderInstructions(FREE_SEGMENTS);
      assert.ok(instructions.includes("🔒 类似先例已锁定"), "Free instructions should contain lock message");
      assert.ok(!instructions.includes("precedents 数组非空"), "Free instructions should not mention precedents array processing");
    });
  });

  describe("buildOrchestrationFinalizerPrompt", () => {
    it("uses Free meta-rules for Pro segments when server not available", () => {
      const prompt = buildOrchestrationFinalizerPrompt(
        "test content",
        [],
        [],
        { triggered: [], overallMultiplier: 1.0, levelUpgrades: [] },
        { bareOnly: [], fullOnly: [], stable: [] },
        [{ event: "test event", date: "2024" }],
        PRO_SEGMENTS,
      );
      // Pro segments from server would instruct precedent output;
      // local fallback uses Free rules (anti-leak)
      assert.ok(prompt.includes("禁止泄露或提及 precedents"), "Free anti-leak rules should apply when Pro server unavailable");
    });

    it("injects Free meta-rules and warns not to leak precedents when given Free segments", () => {
      const prompt = buildOrchestrationFinalizerPrompt(
        "test content",
        [],
        [],
        { triggered: [], overallMultiplier: 1.0, levelUpgrades: [] },
        { bareOnly: [], fullOnly: [], stable: [] },
        [{ event: "test event", date: "2024" }],
        FREE_SEGMENTS,
      );
      assert.ok(prompt.includes("禁止泄露或提及 precedents 中任何具体品牌和事件的名称"), "Free prompt should contain anti-leak instructions");
      assert.ok(prompt.includes("🔒 类似先例已锁定"), "Free prompt should contain lock message from buildFinalRenderInstructions");
    });
  });

  describe("generateAggregatedReport", () => {
    const mockOptions = {
      mode: "orchestration" as any,
      contentSummary: "test summary",
      personas: [],
      preAuditReport: {
        dimensions: [{ id: "social_risk", name: "社伦判官", findings: [] }],
        precedents: [{ event: "test event", date: "2024" }],
      },
    };

    it("includes precedents details when KEVLAR_TIER is pro", () => {
      process.env.KEVLAR_TIER = "pro";
      const report = generateAggregatedReport(mockOptions);
      assert.ok(report.includes("test event（2024）"), "Pro report should include precedent details");
      assert.ok(!report.includes("🔒 类似先例已锁定"), "Pro report should not lock precedents");
    });

    it("locks precedents details when KEVLAR_TIER is free", () => {
      process.env.KEVLAR_TIER = "free";
      const report = generateAggregatedReport(mockOptions);
      assert.ok(report.includes("🔒 类似先例已锁定"), "Free report should lock precedents");
      assert.ok(!report.includes("test event（2024）"), "Free report should not include precedent details");
    });
  });
});
