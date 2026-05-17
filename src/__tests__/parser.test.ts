import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { validateWritePath, parsePersonaFile } from "../utils/parser.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-test-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("validateWritePath", () => {
  it("allows paths within baseDir", () => {
    const allowed = path.join(tmpDir, "foo.md");
    assert.ok(validateWritePath(allowed, tmpDir));
  });

  it("allows paths in subdirectories", () => {
    const allowed = path.join(tmpDir, "sub", "foo.md");
    assert.ok(validateWritePath(allowed, tmpDir));
  });

  it("rejects paths outside baseDir", () => {
    const outside = path.join(os.tmpdir(), "outside.md");
    assert.ok(!validateWritePath(outside, tmpDir));
  });

  it("rejects path traversal attempts", () => {
    const traversal = path.join(tmpDir, "..", "escape.md");
    assert.ok(!validateWritePath(traversal, tmpDir));
  });
});

describe("parsePersonaFile", () => {
  it("parses a valid persona file", async () => {
    const filePath = path.join(tmpDir, "test_persona.md");
    fs.writeFileSync(
      filePath,
      [
        "---",
        "id: test_persona",
        "name: 测试人设",
        "name_en: Test Persona",
        "version: 1.0.0",
        "author: tester",
        "tags:",
        "  - test",
        "  - demo",
        "description: A test persona",
        "---",
        "You are a test persona.",
      ].join("\n"),
      "utf-8"
    );

    const persona = await parsePersonaFile(filePath);
    assert.ok(persona !== null);
    assert.equal(persona.meta.id, "test_persona");
    assert.equal(persona.meta.name, "测试人设");
    assert.equal(persona.meta.tags.length, 2);
    assert.equal(persona.systemPrompt, "You are a test persona.");
  });

  it("skips template files starting with _", async () => {
    const filePath = path.join(tmpDir, "_template.md");
    fs.writeFileSync(filePath, "---\nid: template\nname: Template\n---\nContent", "utf-8");

    const persona = await parsePersonaFile(filePath);
    assert.equal(persona, null);
  });

  it("returns null for missing id in frontmatter", async () => {
    const filePath = path.join(tmpDir, "no_id.md");
    fs.writeFileSync(
      filePath,
      "---\nname: No ID\n---\nContent",
      "utf-8"
    );

    const persona = await parsePersonaFile(filePath);
    assert.equal(persona, null);
  });

  it("returns null for non-existent file", async () => {
    const persona = await parsePersonaFile("/nonexistent/path.md");
    assert.equal(persona, null);
  });
});
