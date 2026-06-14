import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

import {
  buildFinalRenderInstructions,
  buildOrchestrationFinalizerPrompt,
} from "../prompts/reviewWizard.js";
import { generateAggregatedReport } from "../execution/aggregator.js";
import { DEFAULT_FREE_PROMPTS, type PromptSegments } from "../subscription/promptTypes.js";

let tmpDir: string;

const PRO_SEGMENTS: PromptSegments = {
  ...DEFAULT_FREE_PROMPTS,
  finalRenderPrecedentInstruction:
    '如果 JSON 中 precedents 数组非空，后接 bullet 列表，每项格式为："• {event}（{date}）"，date 缺失时省略括号。\n      如果 JSON 中 precedents 数组为空或不存在，输出："暂未检索到类似案例"。',
  orchestrationMetaRuleItem4:
    "4. 本轮职责：执行 Step 6（交叉验证）+ Step 8（最终仲裁），基于代码层已完成的 Step 5（合并）+ Step 7（协同加权）结果",
  orchestrationStep8Item4:
    "4. **场景推演**：生成攻击链分析（attackChainAnalysis）、最坏情况的舆情传播剧本（worstCaseNarrative），以及类似事件先例列表（precedents，若 Turn 1 已检索到则必须输出）",
  finalizerCoreItem4:
    "4. 场景推演：生成攻击链分析（attackChainAnalysis）、最坏情况的舆情传播剧本（worstCaseNarrative），并在其中融入类似先例的历史教训。",
  precedentLockedCn: "",
  precedentLockedEn: "",
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-tier-"));
  process.env.KEVLAR_SKILLS_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.KEVLAR_SKILLS_DIR;
  delete process.env.KEVLAR_TIER;
  delete process.env.KEVLAR_PRO_TOKEN;
});

describe("Tier Split: Free vs Pro Precedents Gating", () => {
  describe("buildFinalRenderInstructions", () => {
    it("renders full precedents listing instructions when given Pro segments", () => {
      const instructions = buildFinalRenderInstructions(PRO_SEGMENTS);
      assert.ok(instructions.includes("precedents 数组非空"), "Pro instructions should mention precedents array processing");
      assert.ok(!instructions.includes("🔒 类似先例已锁定"), "Pro instructions should not contain lock message");
    });

    it("renders locked message instructions when given Free segments", () => {
      const instructions = buildFinalRenderInstructions(DEFAULT_FREE_PROMPTS);
      assert.ok(instructions.includes("🔒 类似先例已锁定"), "Free instructions should contain lock message");
      assert.ok(!instructions.includes("precedents 数组非空"), "Free instructions should not mention precedents array processing");
    });
  });

  describe("buildOrchestrationFinalizerPrompt", () => {
    it("injects Pro meta-rules and instructs rendering precedents when given Pro segments", () => {
      const prompt = buildOrchestrationFinalizerPrompt(
        "test content",
        [],
        [],
        { triggered: [], overallMultiplier: 1.0, levelUpgrades: [] },
        { bareOnly: [], fullOnly: [], stable: [] },
        [{ event: "test event", date: "2024" }],
        PRO_SEGMENTS,
      );
      assert.ok(prompt.includes("类似事件先例列表（precedents，若 Turn 1 已检索到则必须输出）"), "Pro prompt should mention outputting precedents");
      assert.ok(!prompt.includes("🔒 类似先例已锁定"), "Pro prompt should not contain lock message");
    });

    it("injects Free meta-rules and warns not to leak precedents when given Free segments", () => {
      const prompt = buildOrchestrationFinalizerPrompt(
        "test content",
        [],
        [],
        { triggered: [], overallMultiplier: 1.0, levelUpgrades: [] },
        { bareOnly: [], fullOnly: [], stable: [] },
        [{ event: "test event", date: "2024" }],
        DEFAULT_FREE_PROMPTS,
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
