import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { handleHelp } from "../tools/helpTool.js";
import { initI18n } from "../i18n/index.js";

before(async () => {
  await initI18n();
});

describe("handleHelp", () => {
  it("returns HELP_TEXT as text content", async () => {
    const result = await handleHelp();

    const text = result.content[0].text;
    assert.ok(text.includes("Kevlar-4u"));
    assert.ok(text.includes("概述"));
    assert.ok(text.includes("内容评测"));
    assert.ok(text.includes("评审员管理"));
    assert.ok(text.includes("常见问题"));
  });

  it("is not an error", async () => {
    const result = await handleHelp();
    assert.equal(result.isError, undefined);
  });
});
