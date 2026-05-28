import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { handleReviewContentWizard } from "../tools/reviewContentWizardTool.js";
import { writePersonaFile, invalidatePersonasCache } from "../utils/parser.js";
import type { PersonaMeta } from "../utils/parser.js";

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

async function writePersona(id: string, name: string, tags: string[]): Promise<void> {
  const meta: PersonaMeta = {
    id, name, name_en: "Test Persona", version: "1.0.0", author: "kevlar-core",
    tags, description: `${name} 的测试描述`,
  };
  await writePersonaFile(skillsDir, meta, "性格特质：直接。常用平台：小红书。盲区：无特定盲区。");
  invalidatePersonasCache();
}

describe("handleReviewContentWizard state machine", () => {
  it("stores content and asks for persona creation when no personas exist without dumping dispatcher prompt", async () => {
    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "请评测这篇小红书文案：今天分享一个新品故事。",
    });

    const text = textOf(result);
    assert.ok(text.includes("当前还没有可用评审员"));
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

  it("with 1-2 personas: shows all, waits for reviewer confirmation, then executes review", async () => {
    await writePersona("visual_reader", "视觉读者", ["小红书", "视觉"]);
    await writePersona("logic_reader", "逻辑读者", ["知乎", "逻辑"]);

    // Step 1: submit content → waitingForReviewerConfirmation
    const started = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "请评测这篇内容：这是一篇新品发布文案。",
    });

    const startText = textOf(started);
    assert.ok(startText.includes("当前共有 2 位评审员"));
    assert.ok(startText.includes("视觉读者"));
    assert.ok(startText.includes("逻辑读者"));
    assert.ok(startText.includes("请回复「开始复审」确认执行"));
    assert.ok(startText.includes("currentStep: waitingForReviewerConfirmation"));
    assert.ok(!startText.includes("这份内容准备投放在哪些平台"));
    assert.ok(!startText.includes("Kevlar-4u 宿主辅助评测任务"));

    // Step 2: "开始复审" → executes review
    const sessionId = extractSessionId(startText);
    const reviewerDone = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始复审",
    });
    const reviewerText = textOf(reviewerDone);
    assert.ok(
      reviewerText.includes("currentStep: postReview") ||
      reviewerText.includes("评测完成") ||
      reviewerText.includes("评测执行失败")
    );
  });

  it("does not falsely match short persona names", async () => {
    // Create a persona with a very short name "好"
    await writePersona("good_reader", "好", ["小红书", "视觉"]);
    
    const started = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "请评测这篇内容：这是一篇新品发布文案。",
    });
    assert.ok(textOf(started).includes("currentStep: waitingForReviewerConfirmation"));
    const sessionId = extractSessionId(textOf(started));
    
    // User message contains "好" but is not exactly "好" — should not trigger false affirmative
    const selection = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "这篇不好",
    });

    const text = textOf(selection);
    // Should NOT say "已选择：好" — "这篇不好" should not match short persona name
    assert.ok(!text.includes("已选择：好"));
    // Should stay in waitingForReviewerConfirmation since input was not recognized
    assert.ok(text.includes("currentStep: waitingForReviewerConfirmation"));
  });

  it('with 3+ personas: recommends 1-3, shows remaining, waits for reviewer confirmation then executes review', async () => {
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);
    await writePersona("tech_guru", "科技极客", ["知乎", "科技"]);
    await writePersona("mom_user", "宝妈用户", ["抖音", "生活"]);
    await writePersona("student", "学生党", ["B站", "校园"]);

    // Step 1: submit content → waitingForReviewerConfirmation (AI recommends 1-3)
    const started = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "请评测这篇美食文案：这是一篇关于菌菇产品的介绍。",
    });
    const startText = textOf(started);
    const sessionId = extractSessionId(startText);

    assert.ok(startText.includes("currentStep: waitingForReviewerConfirmation"));
    assert.ok(startText.includes("备选评审员"));
    assert.ok(
      startText.includes("美食达人") ||
      startText.includes("科技极客") ||
      startText.includes("宝妈用户") ||
      startText.includes("学生党")
    );

    // Step 2: "开始复审" → executes review
    const reviewerDone = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始复审",
    });
    const reviewerText = textOf(reviewerDone);
    assert.ok(
      reviewerText.includes("currentStep: postReview") ||
      reviewerText.includes("评测完成") ||
      reviewerText.includes("评测执行失败")
    );
  });
});
