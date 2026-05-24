import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-server-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("createKevlarServer", () => {
  it("creates skills directory and returns McpServer instance", async () => {
    const skillsDir = path.join(tmpRoot, "skills");
    assert.ok(!fs.existsSync(skillsDir));

    process.env.KEVLAR_SKILLS_DIR = skillsDir;

    const { createKevlarServer } = await import("../server.js");
    const server = createKevlarServer();

    assert.ok(server, "should return a server");
    assert.ok(fs.existsSync(skillsDir), "should create skills dir");
    assert.ok(typeof server.server?.setRequestHandler, "function");

    delete process.env.KEVLAR_SKILLS_DIR;
  });

  it("cleans stale draft files older than 24h", async () => {
    const skillsDir = path.join(tmpRoot, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    const tmpDir = path.join(skillsDir, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });

    const stalePath = path.join(tmpDir, "old_draft.json");
    fs.writeFileSync(stalePath, JSON.stringify({
      sessionId: "old", createdAt: Date.now() - 90000000, fields: {},
    }), "utf-8");

    const recentPath = path.join(tmpDir, "recent_draft.json");
    fs.writeFileSync(recentPath, JSON.stringify({
      sessionId: "recent", createdAt: Date.now(), fields: {},
    }), "utf-8");

    process.env.KEVLAR_SKILLS_DIR = skillsDir;

    const { createKevlarServer } = await import("../server.js");
    createKevlarServer();

    // The cleanup runs async; wait for it
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(!fs.existsSync(stalePath), "stale draft should be deleted");
    assert.ok(fs.existsSync(recentPath), "recent draft should survive");
    assert.ok(fs.existsSync(tmpDir), "tmp dir should still exist");

    delete process.env.KEVLAR_SKILLS_DIR;
  });
});
