import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { handleCreatePersonaWizard } from "../tools/createPersonaWizardTool.js";
import type { MultiTurnSamplingFunction } from "../execution/base.js";

let skillsDir: string;
let tmpDir: string;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-wizard-skills-"));
  tmpDir = path.join(skillsDir, "tmp");
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

function textOf(result: Awaited<ReturnType<typeof handleCreatePersonaWizard>>): string {
  return result.content.map((c) => c.text).join("\n");
}

function extractSessionId(text: string): string {
  const match = text.match(/sessionId:\s*([a-z0-9-]+)/);
  assert.ok(match, `expected sessionId in response: ${text}`);
  return match[1];
}

describe("handleCreatePersonaWizard fallback state machine", () => {
  it("starts with a single age range question without dumping the full instructions", async () => {
    const result = await handleCreatePersonaWizard(skillsDir, tmpDir, {
      userMessage: "开始创建人设",
    });

    const text = textOf(result);
    assert.ok(text.includes("请问这个角色的年龄段是"));
    assert.ok(text.includes("currentStep: ageRange"));
    assert.ok(!text.includes("=== SYSTEM_PROMPT 开始 ==="));
    assert.ok(!text.includes("角色构建引擎"));
  });

  it("records each step immediately and only asks for final confirmation", async () => {
    const samplingFn: MultiTurnSamplingFunction = async () => ({
      content: JSON.stringify({
        interests: ["独立设计师", "小红书运营", "审美消费"],
        assistantMessage:
          "我帮你总结为以下标签：独立设计师、小红书运营、审美消费。",
      }),
    });

    const started = await handleCreatePersonaWizard(skillsDir, tmpDir, {
      userMessage: "开始创建人设",
    });
    const sessionId = extractSessionId(textOf(started));

    const ageRecorded = await handleCreatePersonaWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "25-30岁（职场新人）",
    });
    assert.ok(textOf(ageRecorded).includes("currentStep: interests"));

    const extracted = await handleCreatePersonaWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "她是一个经常刷小红书、做独立品牌视觉、也会为审美消费买单的人。",
      samplingFn,
    });

    const text = textOf(extracted);
    assert.ok(text.includes("独立设计师、小红书运营、审美消费"));
    assert.ok(text.includes("currentStep: traits"));

    const draftPath = path.join(tmpDir, `${sessionId}_draft.json`);
    const draft = JSON.parse(fs.readFileSync(draftPath, "utf-8"));
    assert.equal(draft.fields.ageRange, "25-30岁（职场新人）");
    assert.deepEqual(draft.fields.interests, [
      "独立设计师",
      "小红书运营",
      "审美消费",
    ]);
  });

  it("allows modifying a collected field at final confirmation", async () => {
    const started = await handleCreatePersonaWizard(skillsDir, tmpDir, {
      userMessage: "开始创建人设",
    });
    const sessionId = extractSessionId(textOf(started));

    await handleCreatePersonaWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "25-30岁",
    });
    await handleCreatePersonaWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "设计、摄影",
    });
    await handleCreatePersonaWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "挑剔，表达直接",
    });
    const finalPreview = await handleCreatePersonaWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "小红书",
    });
    assert.ok(textOf(finalPreview).includes("currentStep: finalConfirm"));

    const modified = await handleCreatePersonaWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "年龄段改成30-35岁（职场中坚）",
    });
    const modifiedText = textOf(modified);
    assert.ok(modifiedText.includes("30-35岁（职场中坚）"));
    assert.ok(modifiedText.includes("currentStep: finalConfirm"));

    const draftPath = path.join(tmpDir, `${sessionId}_draft.json`);
    const draft = JSON.parse(fs.readFileSync(draftPath, "utf-8"));
    assert.equal(draft.fields.ageRange, "30-35岁（职场中坚）");
  });

  it("falls back to heuristic if samplingFn returns invalid JSON", async () => {
    const samplingFn: MultiTurnSamplingFunction = async () => ({
      content: "This is not JSON",
    });

    const started = await handleCreatePersonaWizard(skillsDir, tmpDir, {
      userMessage: "开始创建人设",
    });
    const sessionId = extractSessionId(textOf(started));

    await handleCreatePersonaWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "25-30岁",
    });

    // Should not throw, should fall back
    const extracted = await handleCreatePersonaWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "设计、摄影",
      samplingFn,
    });

    assert.ok(textOf(extracted).includes("currentStep: traits"));
    const draftPath = path.join(tmpDir, `${sessionId}_draft.json`);
    const draft = JSON.parse(fs.readFileSync(draftPath, "utf-8"));
    // Heuristic fallback should extract "设计" and "摄影"
    assert.ok(draft.fields.interests.length > 0);
  });
});
