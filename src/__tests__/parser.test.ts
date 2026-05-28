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
  loadPersonaById,
  loadPersonasByIds,
  loadPersonasByTag,
  deletePersonaFromJson,
  invalidatePersonasCache,
} from "../utils/parser.js";

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

describe("parsePersonaFile (deprecated)", () => {
  it("returns null in Phase 1 JSON migration", async () => {
    const result = await parsePersonaFile("/some/path.md");
    assert.equal(result, null);
  });
});

describe("writePersonaFile & loadAllPersonas (JSON storage)", () => {
  beforeEach(() => {
    invalidatePersonasCache();
  });

  it("writes a persona to the correct JSON file and returns the path", async () => {
    const filePath = await writePersonaFile(tmpDir, {
      id: "test_writer",
      name: "测试写入",
      name_en: "Test Writer",
      version: "1.0.0",
      author: "tester",
      tags: ["test"],
      description: "Test write",
    }, "You are a test persona.");

    assert.ok(filePath.endsWith("fallback.json"));

    const personas = await loadAllPersonas(tmpDir);
    const persona = personas.find(p => p.meta.id === "test_writer");
    assert.ok(persona);
    assert.equal(persona.meta.name, "测试写入");
    assert.equal(persona.systemPrompt, "You are a test persona.");
  });

  it("writes inferred metadata fields to JSON file", async () => {
    await writePersonaFile(tmpDir, {
      id: "test_inferred_writer",
      name: "测试推断写入",
      name_en: "Test Inferred Writer",
      version: "1.0.0",
      author: "tester",
      tags: ["test"],
      description: "Test inferred write",
      culturalContext: "Chinese context",
      authorRelation: "Stranger",
      blindSpot: "Visuals",
    }, "Content here");

    const persona = await loadPersonaById(tmpDir, "test_inferred_writer");
    assert.ok(persona);
    assert.equal(persona.meta.culturalContext, "Chinese context");
    assert.equal(persona.meta.authorRelation, "Stranger");
    assert.equal(persona.meta.blindSpot, "Visuals");
  });

  it("returns empty array when no persona files exist", async () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });
    const personas = await loadAllPersonas(emptyDir);
    assert.deepEqual(personas, []);
  });

  it("overwrites existing persona by same id", async () => {
    await writePersonaFile(tmpDir, {
      id: "overwrite_test",
      name: "Original",
      name_en: "",
      version: "1.0.0",
      author: "tester",
      tags: [],
      description: "Original",
    }, "Original content");

    await writePersonaFile(tmpDir, {
      id: "overwrite_test",
      name: "Updated",
      name_en: "",
      version: "2.0.0",
      author: "tester",
      tags: [],
      description: "Updated",
    }, "Updated content");

    const personas = await loadAllPersonas(tmpDir);
    const persona = personas.find(p => p.meta.id === "overwrite_test");
    assert.equal(persona?.meta.name, "Updated");
    assert.equal(persona?.systemPrompt, "Updated content");
  });
});

describe("loadPersonaById", () => {
  beforeEach(() => {
    invalidatePersonasCache();
  });

  it("returns null for invalid id format", async () => {
    const result = await loadPersonaById(tmpDir, "bad id!");
    assert.equal(result, null);
  });

  it("returns null for non-existent persona", async () => {
    const result = await loadPersonaById(tmpDir, "nonexistent");
    assert.equal(result, null);
  });

  it("returns persona by id", async () => {
    await writePersonaFile(tmpDir, {
      id: "find_me",
      name: "Find Me",
      name_en: "",
      version: "1.0.0",
      author: "tester",
      tags: ["test"],
      description: "Find me",
    }, "content");

    const persona = await loadPersonaById(tmpDir, "find_me");
    assert.ok(persona);
    assert.equal(persona.meta.name, "Find Me");
  });
});

describe("loadPersonasByIds", () => {
  beforeEach(() => {
    invalidatePersonasCache();
  });

  it("returns multiple personas by ids", async () => {
    await writePersonaFile(tmpDir, {
      id: "p1", name: "P1", name_en: "", version: "1.0.0", author: "t", tags: [], description: "d1",
    }, "c1");
    await writePersonaFile(tmpDir, {
      id: "p2", name: "P2", name_en: "", version: "1.0.0", author: "t", tags: [], description: "d2",
    }, "c2");

    const personas = await loadPersonasByIds(tmpDir, ["p1", "p2", "nonexistent"]);
    assert.equal(personas.length, 2);
    assert.equal(personas[0].meta.id, "p1");
    assert.equal(personas[1].meta.id, "p2");
  });
});

describe("loadPersonasByTag", () => {
  beforeEach(() => {
    invalidatePersonasCache();
  });

  it("filters personas by tag", async () => {
    await writePersonaFile(tmpDir, {
      id: "tagged_1", name: "T1", name_en: "", version: "1.0.0", author: "t",
      tags: ["red", "big"], description: "desc",
    }, "c1");
    await writePersonaFile(tmpDir, {
      id: "tagged_2", name: "T2", name_en: "", version: "1.0.0", author: "t",
      tags: ["blue", "big"], description: "desc",
    }, "c2");

    const red = await loadPersonasByTag(tmpDir, "red");
    assert.equal(red.length, 1);
    assert.equal(red[0].meta.id, "tagged_1");

    const big = await loadPersonasByTag(tmpDir, "big");
    assert.equal(big.length, 2);
  });
});

describe("deletePersonaFromJson", () => {
  beforeEach(() => {
    invalidatePersonasCache();
  });

  it("deletes a persona from its JSON file", async () => {
    await writePersonaFile(tmpDir, {
      id: "to_delete", name: "Delete Me", name_en: "", version: "1.0.0", author: "t",
      tags: [], description: "desc",
    }, "content");

    let persona = await loadPersonaById(tmpDir, "to_delete");
    assert.ok(persona);

    const deleted = await deletePersonaFromJson(tmpDir, "to_delete");
    assert.equal(deleted, true);

    persona = await loadPersonaById(tmpDir, "to_delete");
    assert.equal(persona, null);
  });

  it("returns false for non-existent id", async () => {
    const result = await deletePersonaFromJson(tmpDir, "nonexistent");
    assert.equal(result, false);
  });

  it("returns false when no persona files exist", async () => {
    const emptyDir = path.join(tmpDir, "no-config");
    fs.mkdirSync(emptyDir, { recursive: true });
    const result = await deletePersonaFromJson(emptyDir, "anything");
    assert.equal(result, false);
  });
});

describe("loadAllPersonas caching", () => {
  let cacheDir: string;

  beforeEach(() => {
    invalidatePersonasCache();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-cache-test-"));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("loads personas from authored JSON files", async () => {
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

  it("reflects new writes after cache invalidation", async () => {
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
