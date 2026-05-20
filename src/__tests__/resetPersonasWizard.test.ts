import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { handleResetPersonasWizard } from "../tools/resetPersonasWizardTool.js";
import { invalidatePersonasCache } from "../utils/parser.js";

let skillsDir: string;
let tmpDir: string;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-reset-wizard-"));
  tmpDir = path.join(skillsDir, "tmp");
  invalidatePersonasCache();
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
  invalidatePersonasCache();
});

function textOf(result: Awaited<ReturnType<typeof handleResetPersonasWizard>>): string {
  return result.content.map((c) => c.text).join("\n");
}

function extractSessionId(text: string): string {
  const match = text.match(/sessionId:\s*([a-z0-9-]+)/);
  assert.ok(match, `expected sessionId in response: ${text}`);
  return match[1];
}

describe("handleResetPersonasWizard", () => {
  it("previews impact and does not restore before explicit confirmation", async () => {
    const result = await handleResetPersonasWizard(skillsDir, tmpDir, {
      userMessage: "恢复默认人设",
    });

    const text = textOf(result);
    assert.ok(text.includes("将恢复系统内置默认评论员"));
    assert.ok(text.includes("currentStep: confirmReset"));
    assert.equal(fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md")).length, 0);
  });

  it("runs reset only after exact confirmation phrase", async () => {
    const started = await handleResetPersonasWizard(skillsDir, tmpDir, {
      userMessage: "恢复默认人设",
    });
    const sessionId = extractSessionId(textOf(started));

    const wrongConfirm = await handleResetPersonasWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "确认",
    });
    assert.ok(textOf(wrongConfirm).includes("请回复完整确认语"));
    assert.equal(fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md")).length, 0);

    const restored = await handleResetPersonasWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "确认恢复默认评论员",
    });
    const restoredText = textOf(restored);
    assert.ok(restoredText.includes("系统人设恢复完成"));
    assert.ok(fs.readdirSync(skillsDir).some((f) => f.endsWith(".md")));
  });
});
