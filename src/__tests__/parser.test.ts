import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  validateWritePath,
  parsePersonaFile,
  writePersonaFile,
  loadAllPersonas,
  invalidatePersonasCache,
} from "../utils/parser.js";
import { promises as fsp } from "fs";

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

// ─────────────────────────────────────────────────────────────────────────────
// writePersonaFile Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("writePersonaFile", () => {
  beforeEach(() => {
    invalidatePersonasCache();
  });

  it("writes a valid persona file and returns the path", async () => {
    const filePath = await writePersonaFile(tmpDir, {
      id: "test_writer",
      name: "测试写入",
      name_en: "Test Writer",
      version: "1.0.0",
      author: "tester",
      tags: ["test"],
      description: "Test write",
    }, "You are a test persona.");

    assert.ok(filePath.endsWith("test_writer.md"));
    assert.ok(fs.existsSync(filePath));

    const persona = await parsePersonaFile(filePath);
    assert.ok(persona);
    assert.equal(persona.meta.id, "test_writer");
    assert.equal(persona.systemPrompt, "You are a test persona.");
  });

  it("rejects path traversal via id", async () => {
    await assert.rejects(
      () => writePersonaFile(tmpDir, {
        id: "../escape",
        name: "Escape",
        name_en: "Escape",
        version: "1.0.0",
        author: "tester",
        tags: [],
        description: "Escape attempt",
      }, "content"),
      /Invalid file path/
    );
  });

  it("overwrites existing persona file", async () => {
    const filePath = await writePersonaFile(tmpDir, {
      id: "overwrite_test",
      name: "Original",
      name_en: "",
      version: "1.0.0",
      author: "tester",
      tags: [],
      description: "Original",
    }, "Original content");

    const filePath2 = await writePersonaFile(tmpDir, {
      id: "overwrite_test",
      name: "Updated",
      name_en: "",
      version: "2.0.0",
      author: "tester",
      tags: [],
      description: "Updated",
    }, "Updated content");

    assert.equal(filePath, filePath2);

    const persona = await parsePersonaFile(filePath);
    assert.equal(persona?.meta.name, "Updated");
    assert.equal(persona?.systemPrompt, "Updated content");
  });

  it("throws error when file system write fails", async () => {
    const originalWriteFile = fsp.writeFile;
    (fsp as any).writeFile = async () => {
      throw new Error("Simulated I/O Error");
    };

    try {
      await assert.rejects(
        () => writePersonaFile(tmpDir, {
          id: "write_fail_test",
          name: "Fail Test",
          name_en: "",
          version: "1.0.0",
          author: "tester",
          tags: [],
          description: "Fail attempt",
        }, "content"),
        /Simulated I/O Error/
      );
    } finally {
      (fsp as any).writeFile = originalWriteFile;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadAllPersonas Cache Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadAllPersonas caching", () => {
  let cacheDir: string;

  beforeEach(() => {
    invalidatePersonasCache();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-cache-test-"));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("returns cached result on subsequent calls", async () => {
    await writePersonaFile(cacheDir, {
      id: "cache_test",
      name: "Cache Test",
      name_en: "",
      version: "1.0.0",
      author: "tester",
      tags: [],
      description: "",
    }, "content");

    const first = await loadAllPersonas(cacheDir);
    assert.equal(first.length, 1);

    const second = await loadAllPersonas(cacheDir);
    assert.equal(second.length, 1);
  });

  it("invalidates cache after writePersonaFile", async () => {
    await writePersonaFile(cacheDir, {
      id: "cache_inval_test",
      name: "Before",
      name_en: "",
      version: "1.0.0",
      author: "tester",
      tags: [],
      description: "",
    }, "before");

    const before = await loadAllPersonas(cacheDir);
    assert.equal(before.length, 1);

    // Write a new persona — should invalidate cache
    await writePersonaFile(cacheDir, {
      id: "cache_inval_test2",
      name: "After",
      name_en: "",
      version: "1.0.0",
      author: "tester",
      tags: [],
      description: "",
    }, "after");

    const after = await loadAllPersonas(cacheDir);
    assert.equal(after.length, 2);
  });

  it("returns empty array when directory does not exist", async () => {
    const personas = await loadAllPersonas(path.join(cacheDir, "nonexistent"));
    assert.deepEqual(personas, []);
  });
});
