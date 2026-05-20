import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { setConfigPath, readConfig } from "../execution/config.js";
import { handleConfigureWizard } from "../tools/configureWizardTool.js";

let skillsDir: string;
let tmpDir: string;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-config-wizard-"));
  tmpDir = path.join(skillsDir, "tmp");
  setConfigPath(skillsDir);
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

function textOf(result: Awaited<ReturnType<typeof handleConfigureWizard>>): string {
  return result.content.map((c) => c.text).join("\n");
}

function extractSessionId(text: string): string {
  const match = text.match(/sessionId:\s*([a-z0-9-]+)/);
  assert.ok(match, `expected sessionId in response: ${text}`);
  return match[1];
}

describe("handleConfigureWizard", () => {
  it("previews config changes without writing until confirmation", async () => {
    const result = await handleConfigureWizard(tmpDir, {
      userMessage: "切换到 direct api，并发 4",
    });

    const text = textOf(result);
    assert.ok(text.includes("准备修改配置"));
    assert.ok(text.includes("执行模式：直接 API 模式"));
    assert.ok(text.includes("并发数：4"));
    assert.ok(text.includes("currentStep: confirmConfigure"));

    const config = readConfig();
    assert.equal(config.mode, "auto");
    assert.equal(config.multiAgent.maxConcurrency, 3);
  });

  it("writes config only after exact confirmation phrase", async () => {
    const started = await handleConfigureWizard(tmpDir, {
      userMessage: "切换到 mcp sampling，并发 5",
    });
    const sessionId = extractSessionId(textOf(started));

    const wrong = await handleConfigureWizard(tmpDir, {
      sessionId,
      userMessage: "确认",
    });
    assert.ok(textOf(wrong).includes("请回复完整确认语"));
    assert.equal(readConfig().mode, "auto");

    const applied = await handleConfigureWizard(tmpDir, {
      sessionId,
      userMessage: "确认修改配置",
    });
    assert.ok(textOf(applied).includes("配置已更新"));
    assert.equal(readConfig().mode, "mcp_sampling");
    assert.equal(readConfig().multiAgent.maxConcurrency, 5);
  });
});
