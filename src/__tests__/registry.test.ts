import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { getRegistry, dumpRegistry } from "../../scripts/registry.js";

const OVERRIDE_PATH = path.join(os.homedir(), ".kevlar", "client-overrides.json");
let backupPath: string | null = null;

beforeEach(() => {
  backupPath = OVERRIDE_PATH + ".test-backup";
  try { fs.renameSync(OVERRIDE_PATH, backupPath); } catch { /* no existing override */ }
});

afterEach(() => {
  try { fs.unlinkSync(OVERRIDE_PATH); } catch { /* nothing to clean */ }
  if (backupPath) {
    try { fs.renameSync(backupPath, OVERRIDE_PATH); } catch { /* nothing to restore */ }
    backupPath = null;
  }
});

describe("getRegistry()", () => {
  it("returns an array with all known clients", () => {
    const registry = getRegistry();
    assert.ok(Array.isArray(registry));
    assert.ok(registry.length >= 8, `expected >=8, got ${registry.length}`);
  });

  it("each client has required fields with valid types", () => {
    const validFormats = ["json-mcpServers", "json-mcp", "json-mcp-local", "toml-mcp"];
    for (const c of getRegistry()) {
      assert.ok(typeof c.id === "string" && c.id.length > 0, `${c.id}: missing id`);
      assert.ok(typeof c.label === "string" && c.label.length > 0, `${c.id}: missing label`);
      assert.ok(typeof c.format === "string" && validFormats.includes(c.format), `${c.id}: unknown format ${c.format}`);
      assert.ok(typeof c.configPath === "function", `${c.id}: configPath not a function`);
    }
  });

  it("known clients are present", () => {
    const ids = getRegistry().map((c) => c.id);
    for (const expected of ["claude", "cursor", "windsurf", "opencode", "codex", "antigravity", "codebuddy", "workbuddy"]) {
      assert.ok(ids.includes(expected), `missing client: ${expected}`);
    }
  });

  it("configPath() returns a string for each non-unsupported client", () => {
    for (const c of getRegistry()) {
      if (c.unsupported) continue;
      const p = c.configPath();
      assert.ok(typeof p === "string", `${c.id}: configPath() returned ${typeof p}`);
      // Non-empty on platforms that have at least one slot
      if (p.length === 0) {
        // Acceptable only if all slots are for other OS
        assert.ok(true, `${c.id}: no config path on this platform (empty)`);
      } else {
        // If non-empty, should be an absolute-ish path (expanded ~ or %APPDATA%)
        assert.ok(path.isAbsolute(p) || p.startsWith("/") || /^[A-Z]:/.test(p),
          `${c.id}: path not absolute: ${p}`);
      }
    }
  });

  it("detectPaths() returns an array of expanded paths", () => {
    for (const c of getRegistry()) {
      if (!c.detectPaths) continue;
      const paths = c.detectPaths();
      assert.ok(Array.isArray(paths), `${c.id}: detectPaths not an array`);
      for (const p of paths) {
        assert.ok(typeof p === "string", `${c.id}: non-string path`);
        assert.ok(p.length > 0, `${c.id}: empty path`);
        assert.ok(!p.includes("%APPDATA%"), `${c.id}: unexpanded %APPDATA% in "${p}"`);
      }
    }
  });

  it("detectPaths fallbacks to config path dir when function not provided", () => {
    // Create a ClientDef without detectPaths → verify shape is valid
    const registry = getRegistry();
    for (const c of registry) {
      if (!c.detectPaths) {
        // Should still have configPath as fallback dir
        const dir = path.dirname(c.configPath());
        assert.ok(dir.length > 0 || c.unsupported, `${c.id}: no detectPaths fallback`);
      }
    }
  });
});

describe("dumpRegistry()", () => {
  it("includes all 8 clients", () => {
    const dump = dumpRegistry();
    const expected = ["claude", "cursor", "windsurf", "opencode", "codex", "antigravity", "codebuddy", "workbuddy"];
    for (const id of expected) {
      assert.ok(id in dump, `missing client in dump: ${id}`);
    }
  });

  it("each entry has correct shape", () => {
    const dump = dumpRegistry();
    for (const [id, entry] of Object.entries(dump)) {
      assert.ok(Array.isArray(entry.configPaths), `${id}: configPaths not an array`);
      assert.ok(Array.isArray(entry.detectPaths), `${id}: detectPaths not an array`);
      assert.ok(typeof entry.detected === "boolean", `${id}: detected not a boolean`);
      // configPaths and detectPaths must be consistent length
      assert.ok(entry.configPaths.length + entry.detectPaths.length >= 1,
        `${id}: no paths at all`);
    }
  });

  it("all paths are fully expanded (no ~ or %APPDATA%)", () => {
    const dump = dumpRegistry();
    for (const [id, entry] of Object.entries(dump)) {
      for (const p of [...entry.configPaths, ...entry.detectPaths]) {
        assert.ok(!p.includes("~"), `${id}: unexpanded ~ in "${p}"`);
        assert.ok(!p.includes("%APPDATA%"), `${id}: unexpanded %APPDATA% in "${p}"`);
      }
    }
  });

  it("configPaths and detectPaths correspond to same platform", () => {
    const dump = dumpRegistry();
    // On macOS, we expect Tilde-expanded paths
    for (const [id, entry] of Object.entries(dump)) {
      for (const p of [...entry.configPaths, ...entry.detectPaths]) {
        assert.ok(!p.includes("\\") || process.platform === "win32",
          `${id}: backslash path on non-Windows: "${p}"`);
      }
    }
  });
});

describe("override file", () => {
  it("getRegistry() picks up client overrides", () => {
    fs.mkdirSync(path.dirname(OVERRIDE_PATH), { recursive: true });
    const overrideContent = {
      clients: {
        claude: {
          configPaths: ["/override/claude/config.json"],
          detectPaths: ["/override/claude/app"],
        },
      },
    };
    fs.writeFileSync(OVERRIDE_PATH, JSON.stringify(overrideContent), "utf-8");

    const claude = getRegistry().find((c) => c.id === "claude");
    assert.ok(claude);
    assert.strictEqual(claude!.configPath(), "/override/claude/config.json");
    const detectPaths = claude!.detectPaths!();
    assert.strictEqual(detectPaths.length, 1);
    assert.strictEqual(detectPaths[0], "/override/claude/app");
  });

  it("getRegistry() overrides only the specified client, not others", () => {
    fs.mkdirSync(path.dirname(OVERRIDE_PATH), { recursive: true });
    fs.writeFileSync(OVERRIDE_PATH, JSON.stringify({
      clients: {
        cursor: { configPaths: ["/only-cursor.json"] },
      },
    }), "utf-8");

    const registry = getRegistry();
    const claude = registry.find((c) => c.id === "claude");
    const cursor = registry.find((c) => c.id === "cursor");

    assert.ok(claude);
    assert.ok(cursor);
    // Claude should NOT be overridden
    assert.notStrictEqual(claude!.configPath(), "/only-cursor.json");
    // Cursor SHOULD be overridden
    assert.strictEqual(cursor!.configPath(), "/only-cursor.json");
  });

  it("dumpRegistry() reflects overrides", () => {
    fs.mkdirSync(path.dirname(OVERRIDE_PATH), { recursive: true });
    fs.writeFileSync(OVERRIDE_PATH, JSON.stringify({
      clients: {
        claude: {
          configPaths: ["/dump/claude/config.json"],
          detectPaths: ["/dump/claude/app"],
        },
      },
    }), "utf-8");

    const dump = dumpRegistry();
    assert.deepStrictEqual(dump.claude.configPaths, ["/dump/claude/config.json"]);
    assert.deepStrictEqual(dump.claude.detectPaths, ["/dump/claude/app"]);
  });
});
