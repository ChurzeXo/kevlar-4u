import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  scanForCredentials,
  stripPromptBoundaries,
  wrapContent,
} from "../utils/sanitize.js";

describe("scanForCredentials", () => {
  it("detects Anthropic API keys (sk-ant-)", () => {
    const result = scanForCredentials("my key is sk-ant-abcdefghijklmnopqr123456, keep it safe");
    assert.ok(result.length > 0);
    assert.ok(result[0].startsWith("sk-ant-a"));
    assert.ok(result[0].endsWith("****"));
  });

  it("detects OpenAI API keys (sk-)", () => {
    const result = scanForCredentials("key=sk-abcdefghijklmnopqrstuvwxyz1234567890abcde");
    assert.ok(result.length > 0);
    assert.ok(result[0].endsWith("****"));
  });

  it("detects Google AI keys (AIza)", () => {
    const result = scanForCredentials("AIzaSyAAAAAAAAABBBBBBBBBBBCCCCCCCCCCCDDDDDD");
    assert.ok(result.length > 0);
  });

  it("detects GitHub personal access tokens (ghp_)", () => {
    const result = scanForCredentials("token ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    assert.ok(result.length > 0);
  });

  it("detects GitHub org tokens (gho_)", () => {
    const result = scanForCredentials("gho_abcdefghijklmnopqrstuvwxyz1234567890");
    assert.ok(result.length > 0);
  });

  it("detects Slack tokens (xoxb-)", () => {
    // Construct token at test time to avoid GitHub secret scanner false positive
    const prefix = "xoxb";
    const token = `${prefix}-1234567890-1234567890-abcdefghijklmnopABCDEFGH`;
    const result = scanForCredentials(token);
    assert.ok(result.length > 0);
    assert.ok(result[0].match(/xoxb-/));
  });

  it("detects generic api/secret/key patterns with 16+ chars", () => {
    const result = scanForCredentials("api_key_abcdefghijklmnopqrstuvwx");
    assert.ok(result.length > 0);
  });

  it("returns empty array for safe text", () => {
    const result = scanForCredentials("this is just normal text with no keys");
    assert.deepEqual(result, []);
  });

  it("deduplicates matching patterns", () => {
    const key = "sk-ant-abcdefghijklmnopqr123456";
    const result = scanForCredentials(`${key} and ${key} again`);
    assert.equal(result.length, 1);
  });

  it("truncates leaked key to first 8 chars + ****", () => {
    const result = scanForCredentials("sk-ant-abcdefghijklmnopqr123456");
    assert.ok(result[0].length <= 13);
    assert.ok(result[0].includes("****"));
  });
});

describe("stripPromptBoundaries", () => {
  it("removes **指令** markers", () => {
    const result = stripPromptBoundaries("before **指令** after");
    assert.ok(!result.includes("**指令**"));
    assert.ok(result.includes("before"));
    assert.ok(result.includes("after"));
  });

  it("removes **角色描述** markers", () => {
    const result = stripPromptBoundaries("before **角色描述** after");
    assert.ok(!result.includes("**角色描述**"));
    assert.ok(result.includes("before"));
    assert.ok(result.includes("after"));
  });

  it("removes **待评审内容** markers", () => {
    const result = stripPromptBoundaries("before **待评审内容** after");
    assert.ok(!result.includes("**待评审内容**"));
    assert.ok(result.includes("before"));
    assert.ok(result.includes("after"));
  });

  it("removes **发布平台 & 目标受众背景** markers", () => {
    const result = stripPromptBoundaries("before **发布平台 & 目标受众背景** after");
    assert.ok(!result.includes("**发布平台"));
    assert.ok(result.includes("before"));
    assert.ok(result.includes("after"));
  });

  it("removes **发布平台 ＆ 目标受众背景** (fullwidth &)", () => {
    const result = stripPromptBoundaries("before **发布平台 ＆ 目标受众背景** after");
    assert.ok(!result.includes("**发布平台"));
    assert.ok(result.includes("before"));
    assert.ok(result.includes("after"));
  });

  it("removes the strict output format instruction", () => {
    const result = stripPromptBoundaries("text before 请严格按照该人设要求的输出格式作答。 text after");
    assert.ok(!result.includes("请严格按照该人设要求的输出格式作答"));
    assert.ok(result.includes("text before"));
    assert.ok(result.includes("text after"));
  });

  it("removes markdown headings", () => {
    const result = stripPromptBoundaries("## Heading\ncontent\n### Sub");
    assert.ok(!result.includes("## "));
    assert.ok(result.includes("Heading"));
    assert.ok(result.includes("Sub"));
  });

  it("removes horizontal rules", () => {
    const result = stripPromptBoundaries("above\n---\nbelow");
    assert.ok(!result.includes("---"));
    assert.ok(result.includes("above"));
    assert.ok(result.includes("below"));
  });

  it("trims whitespace", () => {
    const result = stripPromptBoundaries("  **指令** content  ");
    assert.equal(result, "content");
  });

  it("handles multiple patterns in one string", () => {
    const result = stripPromptBoundaries(
      "## Title\n**角色描述**\nYou are helpful.\n**指令**\nDo X.\n---"
    );
    assert.ok(!result.includes("## "));
    assert.ok(!result.includes("**角色描述**"));
    assert.ok(!result.includes("**指令**"));
    assert.ok(result.includes("Title"));
    assert.ok(result.includes("You are helpful"));
    assert.ok(result.includes("Do X"));
  });
});

describe("wrapContent", () => {
  it("wraps content in random-suffixed tags", () => {
    const result = wrapContent("hello world");
    assert.ok(result.startsWith("<content_"));
    assert.ok(result.endsWith(">"));
    assert.ok(result.includes("hello world"));
    assert.ok(result.includes("</content_"));
  });

  it("uses custom tag prefix", () => {
    const result = wrapContent("test", "sp");
    assert.ok(result.startsWith("<sp_"));
    assert.ok(result.includes("</sp_"));
  });

  it("escapes matching tags inside content", () => {
    const result = wrapContent("<content_abc123>nested</content_abc123>");
    assert.ok(!result.includes("<content_abc123>"));
  });

  it("puts content on its own line", () => {
    const result = wrapContent("hello");
    const lines = result.split("\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[1], "hello");
  });
});
