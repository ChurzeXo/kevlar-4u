import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { handleDeletePersonaWizard } from "../tools/deletePersonaWizardTool.js";
import { invalidatePersonasCache } from "../utils/parser.js";

let skillsDir: string;
let tmpDir: string;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-delete-wizard-"));
  tmpDir = path.join(skillsDir, "tmp");
  invalidatePersonasCache();
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
  invalidatePersonasCache();
});

function textOf(result: Awaited<ReturnType<typeof handleDeletePersonaWizard>>): string {
  return result.content.map((c) => c.text).join("\n");
}

function extractSessionId(text: string): string {
  const match = text.match(/sessionId:\s*([a-z0-9-]+)/);
  assert.ok(match, `expected sessionId in response: ${text}`);
  return match[1];
}

function writePersona(id: string, name: string): string {
  const filePath = path.join(skillsDir, `${id}.md`);
  const file = [
    "---",
    `id: ${id}`,
    `name: ${name}`,
    "name_en: Test Persona",
    "version: 1.0.0",
    "author: ai-generated",
    "tags:",
    "  - test",
    `description: ${name} 的测试描述`,
    "---",
    "性格特质：直接。常用平台：小红书。盲区：无特定盲区。",
  ].join("\n");
  fs.writeFileSync(filePath, file, "utf-8");
  invalidatePersonasCache();
  return filePath;
}

describe("handleDeletePersonaWizard", () => {
  it("binds the selected persona to a session and does not delete before explicit confirmation", async () => {
    const filePath = writePersona("visual_reader", "视觉读者");

    const result = await handleDeletePersonaWizard(skillsDir, tmpDir, {
      userMessage: "删除视觉读者",
    });

    const text = textOf(result);
    assert.ok(text.includes("视觉读者"));
    assert.ok(text.includes("确认删除"));
    assert.ok(text.includes("currentStep: confirmDelete"));
    assert.ok(fs.existsSync(filePath));
  });

  it("deletes only after the user confirms the bound persona name", async () => {
    const filePath = writePersona("visual_reader", "视觉读者");

    const started = await handleDeletePersonaWizard(skillsDir, tmpDir, {
      userMessage: "删除视觉读者",
    });
    const sessionId = extractSessionId(textOf(started));

    const wrongConfirm = await handleDeletePersonaWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "确认删除别的角色",
    });
    assert.ok(textOf(wrongConfirm).includes("请回复完整确认语"));
    assert.ok(fs.existsSync(filePath));

    const deleted = await handleDeletePersonaWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "确认删除视觉读者",
    });

    assert.ok(textOf(deleted).includes("已删除"));
    assert.ok(!fs.existsSync(filePath));
  });
});
