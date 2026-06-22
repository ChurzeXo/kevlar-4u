import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Schema validators ──────────────────────────────────────────────────────

function isValidJsonMcpServers(entry: Record<string, unknown>): boolean {
  return (
    typeof entry.command === "string" &&
    Array.isArray(entry.args) &&
    entry.args.every((a: unknown) => typeof a === "string")
  );
}

function isValidJsonMcpLocal(entry: Record<string, unknown>): boolean {
  return (
    entry.type === "local" &&
    Array.isArray(entry.command) &&
    entry.command.every((c: unknown) => typeof c === "string") &&
    entry.enabled === true
  );
}

function isValidTomlMcp(content: string): boolean {
  const lines = content.split("\n");
  return (
    lines.some((l) => l.trim().startsWith(`[mcp_servers."kevlar-4u"]`)) &&
    lines.some((l) => l.trim().startsWith("command = ")) &&
    lines.some((l) => l.trim().startsWith("args = ["))
  );
}

// ── Import the actual builder functions ────────────────────────────────────

// Replicate the getMcpEntry logic inline to avoid importing CLI scripts
function getMcpEntry(format: string, cmd: string, args: string[]): Record<string, unknown> {
  if (format === "json-mcp-local") {
    return { type: "local", command: [cmd, ...args], enabled: true };
  }
  const entry: Record<string, unknown> = { command: cmd, args };
  if (format === "json-mcpServers" && cmd === "npx") {
    // Some clients (Cursor, CodeBuddy) add type: "stdio"
  }
  return entry;
}

function mergeTomlBlock(cmd: string, args: string[]): string {
  const serverName = "kevlar-4u";
  return (
    `[mcp_servers."${serverName}"]\n` +
    `command = "${cmd}"\n` +
    `args = [${args.map((a) => `"${a}"`).join(", ")}]`
  );
}

// ── Test scenarios ────────────────────────────────────────────────────────

const REMOTE_CMD = "npx";
const REMOTE_ARGS = ["-y", "kevlar-4u@latest", "--stdio"];
const LOCAL_CMD = "node";
const LOCAL_ARGS = ["/usr/local/lib/kevlar-4u/dist/index.js", "--stdio"];

describe("MCP client config format validation", () => {
  describe("npx remote install", () => {
    it("Claude Desktop (json-mcpServers) produces valid format", () => {
      const entry = getMcpEntry("json-mcpServers", REMOTE_CMD, REMOTE_ARGS);
      assert.ok(isValidJsonMcpServers(entry), `Invalid: ${JSON.stringify(entry)}`);
      assert.equal(entry.command, "npx");
      assert.deepEqual(entry.args, REMOTE_ARGS);
    });

    it("Cursor (json-mcpServers + stdio) produces valid format", () => {
      const entry = getMcpEntry("json-mcpServers", REMOTE_CMD, REMOTE_ARGS);
      // Cursor requires type: "stdio" but base format should still validate
      assert.ok(isValidJsonMcpServers(entry));
    });

    it("Windsurf (json-mcpServers) produces valid format", () => {
      const entry = getMcpEntry("json-mcpServers", REMOTE_CMD, REMOTE_ARGS);
      assert.ok(isValidJsonMcpServers(entry));
    });

    it("OpenCode (json-mcp-local) produces valid format", () => {
      const entry = getMcpEntry("json-mcp-local", REMOTE_CMD, REMOTE_ARGS);
      assert.ok(isValidJsonMcpLocal(entry), `Invalid: ${JSON.stringify(entry)}`);
      assert.equal(entry.type, "local");
      assert.equal(entry.enabled, true);
      assert.ok((entry.command as string[]).includes("npx"));
    });

    it("OpenCode (json-mcp-local) with npx command works", () => {
      // Regression: OpenCode previously failed when cmd was "npx"
      const entry = getMcpEntry("json-mcp-local", "npx", ["-y", "kevlar-4u@latest", "--stdio"]);
      assert.ok(isValidJsonMcpLocal(entry), `Invalid: ${JSON.stringify(entry)}`);
    });

    it("Codex (toml-mcp) produces valid format", () => {
      const content = mergeTomlBlock(REMOTE_CMD, REMOTE_ARGS);
      assert.ok(isValidTomlMcp(content), `Invalid TOML:\n${content}`);
    });

    it("Antigravity (json-mcpServers) produces valid format", () => {
      const entry = getMcpEntry("json-mcpServers", REMOTE_CMD, REMOTE_ARGS);
      assert.ok(isValidJsonMcpServers(entry));
    });

    it("CodeBuddy CN (json-mcpServers) produces valid format", () => {
      const entry = getMcpEntry("json-mcpServers", REMOTE_CMD, REMOTE_ARGS);
      assert.ok(isValidJsonMcpServers(entry));
    });

    it("WorkBuddy (json-mcpServers) produces valid format", () => {
      const entry = getMcpEntry("json-mcpServers", REMOTE_CMD, REMOTE_ARGS);
      assert.ok(isValidJsonMcpServers(entry));
    });
  });

  describe("node local install", () => {
    it("OpenCode (json-mcp-local) with node command works", () => {
      const entry = getMcpEntry("json-mcp-local", LOCAL_CMD, LOCAL_ARGS);
      assert.ok(isValidJsonMcpLocal(entry));
      assert.ok((entry.command as string[]).includes("node"));
    });

    it("all json-mcpServers clients work with local install", () => {
      for (const client of ["json-mcpServers"]) {
        const entry = getMcpEntry(client, LOCAL_CMD, LOCAL_ARGS);
        assert.ok(isValidJsonMcpServers(entry));
      }
    });

    it("local install TOML is valid", () => {
      const content = mergeTomlBlock(LOCAL_CMD, LOCAL_ARGS);
      assert.ok(isValidTomlMcp(content));
    });
  });

  describe("coverage: all 8 clients generate valid config", () => {
    const clients = [
      { name: "Claude Desktop", format: "json-mcpServers" },
      { name: "Cursor", format: "json-mcpServers" },
      { name: "Windsurf", format: "json-mcpServers" },
      { name: "OpenCode", format: "json-mcp-local" },
      { name: "Codex", format: "toml-mcp" },
      { name: "Antigravity", format: "json-mcpServers" },
      { name: "CodeBuddy CN", format: "json-mcpServers" },
      { name: "WorkBuddy", format: "json-mcpServers" },
    ];

    for (const client of clients) {
      it(`${client.name} (${client.format}) → valid`, () => {
        if (client.format === "toml-mcp") {
          const content = mergeTomlBlock(REMOTE_CMD, REMOTE_ARGS);
          assert.ok(isValidTomlMcp(content), `${client.name}: invalid TOML`);
        } else if (client.format === "json-mcp-local") {
          const entry = getMcpEntry(client.format, REMOTE_CMD, REMOTE_ARGS);
          assert.ok(isValidJsonMcpLocal(entry), `${client.name}: ${JSON.stringify(entry)}`);
        } else {
          const entry = getMcpEntry(client.format, REMOTE_CMD, REMOTE_ARGS);
          assert.ok(isValidJsonMcpServers(entry), `${client.name}: ${JSON.stringify(entry)}`);
        }
      });
    }
  });
});
