import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { handleDeletePersona } from "../tools/deletePersonaTool.js";
import { handleSetLanguage } from "../tools/languageTool.js";
import { invalidatePersonasCache } from "../utils/parser.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function writePersonaFile(skillsDir: string, id: string, name: string) {
  const personaFile = path.join(skillsDir, "test_personas.json");
  const data = {
    version: "1.0",
    last_updated: "2026-06-01",
    personas: {
      [id]: {
        meta: {
          id,
          name,
          name_en: "Test Persona",
          version: "1.0",
          author: "test",
          tags: ["test_tag"],
          description: "A test persona",
          culturalContext: "zh-CN",
          authorRelation: "无",
          perspective: "客观",
          blindSpot: "无",
          dimensionBias: [],
        },
        systemPrompt: "You are a test persona.",
      },
    },
  };
  fs.writeFileSync(personaFile, JSON.stringify(data, null, 2), "utf-8");
}

function readPersonaFile(skillsDir: string): any {
  const personaFile = path.join(skillsDir, "test_personas.json");
  if (!fs.existsSync(personaFile)) return null;
  return JSON.parse(fs.readFileSync(personaFile, "utf-8"));
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let skillsDir: string;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-small-tools-"));
  invalidatePersonasCache();
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
  invalidatePersonasCache();
});

// ── Tests: deletePersona ──────────────────────────────────────────────────────

describe("deletePersona", () => {
  it("returns error without confirm flag", async () => {
    const result = await handleDeletePersona(skillsDir, {
      id: "test_001",
      confirm: false,
    });
    assert.equal(result.isError, true);
    assert.ok(
      result.content![0].text.includes("二次确认"),
      "should ask for confirmation"
    );
  });

  it("returns error when persona not found", async () => {
    const result = await handleDeletePersona(skillsDir, {
      id: "nonexistent_id",
      confirm: true,
    });
    assert.equal(result.isError, true);
    assert.ok(result.content![0].text.includes("找不到"));
  });

  it("successfully deletes an existing persona", async () => {
    writePersonaFile(skillsDir, "test_001", "测试评审员");

    const result = await handleDeletePersona(skillsDir, {
      id: "test_001",
      confirm: true,
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content![0].text.includes("已删除"));
    assert.ok(result.content![0].text.includes("测试评审员"));

    // Verify the persona was actually removed from file
    const updated = readPersonaFile(skillsDir);
    assert.equal(updated.personas["test_001"], undefined);
  });

  it("handles deleting already-deleted persona", async () => {
    // No persona file at all → deletePersonaFromJson returns false
    const result = await handleDeletePersona(skillsDir, {
      id: "test_001",
      confirm: true,
    });
    // loadPersonaById returns null → "找不到"
    assert.equal(result.isError, true);
    assert.ok(result.content![0].text.includes("找不到"));
  });
});

// ── Tests: language/set_language ──────────────────────────────────────────────

describe("set_language", () => {
  it("returns error for invalid language code", async () => {
    const result = await handleSetLanguage("fr-FR");
    assert.equal(result.isError, true);
    assert.ok(result.content![0].text.includes("Invalid language"));
  });

  it("returns error for empty language", async () => {
    const result = await handleSetLanguage("");
    assert.equal(result.isError, true);
  });

  it("switches to Chinese", async () => {
    const result = await handleSetLanguage("zh-CN");
    assert.equal(result.isError, undefined);
    assert.ok(result.content![0].text.includes("简体中文"));
    assert.ok(result.content![0].text.includes("zh-CN"));
  });

  it("switches to English", async () => {
    const result = await handleSetLanguage("en-US");
    assert.equal(result.isError, undefined);
    assert.ok(result.content![0].text.includes("English"));
    assert.ok(result.content![0].text.includes("en-US"));
  });

  it("reports previous language in switch message", async () => {
    // Switch to Chinese first
    await handleSetLanguage("zh-CN");
    // Then switch to English — should mention previous was Chinese
    const result = await handleSetLanguage("en-US");
    assert.ok(result.content![0].text.includes("简体中文"));
  });
});

// ── Tests: checkUpdate helpers ────────────────────────────────────────────────

describe("checkUpdate", () => {
  // compareVersions is not exported, so we test it via reflection or
  // through the handler (which requires network mocking).
  // Instead we test version comparison logic indirectly.

  it("handler resolves local version without network crash", async () => {
    // The handler calls fetchVersionFromServer which will fail without network,
    // but it should catch gracefully and return a result with local version.
    const { checkUpdateModule } = await import("../tools/checkUpdateTool.js");
    const toolHandler = (checkUpdateModule.handler as any)();
    const result = await toolHandler();

    // Should never throw — errors are caught
    assert.ok(typeof result === "object");
    assert.ok(Array.isArray(result.content));
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.ok(text.includes("当前版本"), "should show local version");
    assert.ok(
      text.includes("无法检查更新") || text.includes("已是最新版本") || text.includes("新版本"),
      "should show update status"
    );
  });

  it("checkForUpdate (exported helper) handles network failure gracefully", async () => {
    const { checkForUpdate } = await import("../tools/checkUpdateTool.js");
    // Network will fail in test env → returns null without throwing
    const result = await checkForUpdate();
    assert.equal(result, null);
  });
});
