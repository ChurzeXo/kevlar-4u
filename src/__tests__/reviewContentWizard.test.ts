import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { handleReviewContentWizard } from "../tools/reviewContentWizardTool.js";
import { invalidatePersonasCache } from "../utils/parser.js";

let skillsDir: string;
let tmpDir: string;
let previousApiKey: string | undefined;
let previousOpenAiKey: string | undefined;
let previousAnthropicKey: string | undefined;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-review-wizard-"));
  tmpDir = path.join(skillsDir, "tmp");
  previousApiKey = process.env.KEVLAR_API_KEY;
  previousOpenAiKey = process.env.OPENAI_API_KEY;
  previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.KEVLAR_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  invalidatePersonasCache();
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
  if (previousApiKey === undefined) delete process.env.KEVLAR_API_KEY;
  else process.env.KEVLAR_API_KEY = previousApiKey;
  if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAiKey;
  if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
  invalidatePersonasCache();
});

function textOf(result: Awaited<ReturnType<typeof handleReviewContentWizard>>): string {
  return result.content.map((c) => c.text).join("\n");
}

function extractSessionId(text: string): string {
  const match = text.match(/sessionId:\s*([a-z0-9-]+)/);
  assert.ok(match, `expected sessionId in response: ${text}`);
  return match[1];
}

function writePersona(id: string, name: string, tags: string[]): void {
  const file = [
    "---",
    `id: ${id}`,
    `name: ${name}`,
    "name_en: Test Persona",
    "version: 1.0.0",
    "author: kevlar-core",
    "tags:",
    ...tags.map((tag) => `  - ${tag}`),
    `description: ${name} 的测试描述`,
    "---",
    "性格特质：直接。常用平台：小红书。盲区：无特定盲区。",
  ].join("\n");
  fs.writeFileSync(path.join(skillsDir, `${id}.md`), file, "utf-8");
  invalidatePersonasCache();
}

describe("handleReviewContentWizard state machine", () => {
  it("stores content and asks for persona creation when no personas exist without dumping dispatcher prompt", async () => {
    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "请评测这篇小红书文案：今天分享一个新品故事。",
    });

    const text = textOf(result);
    assert.ok(text.includes("当前还没有可用评论员"));
    assert.ok(text.includes("currentStep: waitingForPersonaCreation"));
    assert.ok(text.includes("sessionId:"));
    assert.ok(!text.includes("=== SYSTEM_PROMPT 开始 ==="));
    assert.ok(!text.includes("你是一个内容评论调度引擎"));

    const sessionId = extractSessionId(text);
    const state = JSON.parse(
      fs.readFileSync(path.join(tmpDir, `${sessionId}_review_wizard.json`), "utf-8")
    );
    assert.ok(state.content.includes("新品故事"));
  });

  it("shows all personas when only two exist and executes review only after confirmation", async () => {
    writePersona("visual_reader", "视觉读者", ["小红书", "视觉"]);
    writePersona("logic_reader", "逻辑读者", ["知乎", "逻辑"]);

    const started = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "请评测这篇内容：这是一篇新品发布文案。",
    });

    const startText = textOf(started);
    assert.ok(startText.includes("当前只有 2 位评论员可用"));
    assert.ok(startText.includes("视觉读者"));
    assert.ok(startText.includes("逻辑读者"));
    assert.ok(startText.includes("currentStep: confirmSelection"));
    assert.ok(!startText.includes("Kevlar 宿主辅助评测任务"));

    const sessionId = extractSessionId(startText);
    const executed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "确认",
    });

    const executedText = textOf(executed);
    assert.ok(executedText.includes("Kevlar 宿主辅助评测任务"));
    assert.ok(executedText.includes("视觉读者"));
    assert.ok(executedText.includes("逻辑读者"));
  });

  it("does not treat '这是什么意思' as an affirmative confirmation", async () => {
    writePersona("visual_reader", "视觉读者", ["小红书", "视觉"]);
    
    const started = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "请评测这篇内容：这是一篇新品发布文案。",
    });
    const sessionId = extractSessionId(textOf(started));
    
    // Select persona
    await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "视觉读者",
    });

    // Try to confirm with ambiguous word containing "是"
    const executed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "这是什么意思",
    });

    const executedText = textOf(executed);
    // Should NOT execute review.
    assert.ok(!executedText.includes("Kevlar 宿主辅助评测任务"));
  });

  it("does not falsely match short persona names", async () => {
    // Create a persona with a very short name "好"
    writePersona("good_reader", "好", ["小红书", "视觉"]);
    
    const started = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "请评测这篇内容：这是一篇新品发布文案。",
    });
    const sessionId = extractSessionId(textOf(started));
    
    // User message contains "好" but is not exactly "好"
    const selection = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "这篇不好",
    });

    const text = textOf(selection);
    // Should NOT say "已选择：好"
    assert.ok(!text.includes("已选择：好"));
  });
});
