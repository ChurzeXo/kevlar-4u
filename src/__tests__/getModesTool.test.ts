import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-modes-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("handleGetModes", () => {
  it("returns markdown table with mode info", async () => {
    // Create a config so readConfigAsync returns real data
    const config = {
      mode: "auto",
      maxConcurrency: 3,
    };
    fs.writeFileSync(
      path.join(root, "kevlar-config.json"),
      JSON.stringify(config),
      "utf-8"
    );

    process.env.KEVLAR_SKILLS_DIR = root;
    process.env.KEVLAR_API_KEY = "sk-test-key";

    const { handleGetModes } = await import("../tools/getModesTool.js");

    const result = await handleGetModes();
    const text = result.content[0].text;

    assert.ok(text.includes("可用执行模式"));
    assert.ok(text.includes("直接 API 模式"));

    delete process.env.KEVLAR_SKILLS_DIR;
    delete process.env.KEVLAR_API_KEY;
  });

  it("shows direct_api as unconfigured when no API key", async () => {
    const config = { mode: "auto", maxConcurrency: 3 };
    fs.writeFileSync(
      path.join(root, "kevlar-config.json"),
      JSON.stringify(config),
      "utf-8"
    );

    // Import fresh with new env
    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-modes-no-key-"));
    fs.writeFileSync(
      path.join(freshRoot, "kevlar-config.json"),
      JSON.stringify(config),
      "utf-8"
    );

    process.env.KEVLAR_SKILLS_DIR = freshRoot;
    delete process.env.KEVLAR_API_KEY;

    // Need a fresh import - ESM cache may prevent this
    const { handleGetModes } = await import("../tools/getModesTool.js");
    const result = await handleGetModes();
    const text = result.content[0].text;

    assert.ok(text.includes("KEVLAR_API_KEY"));

    delete process.env.KEVLAR_SKILLS_DIR;
  });
});
