import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleHelp } from "../tools/helpTool.js";

describe("handleHelp", () => {
  it("returns HELP_TEXT as text content", async () => {
    const result = await handleHelp();

    const text = result.content[0].text;
    assert.ok(text.includes("Kevlar-4u 使用帮助"));
    assert.ok(text.includes("开始一次评测"));
    assert.ok(text.includes("创建自定义评论员"));
    assert.ok(text.includes("常见问题"));
  });

  it("is not an error", async () => {
    const result = await handleHelp();
    assert.equal(result.isError, undefined);
  });
});
