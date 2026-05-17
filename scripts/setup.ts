// Kevlar — scripts/setup.ts
// Automated installation and MCP configuration injection script (Zero-Config fallback)
// This is the lightweight alternative to the full CLI (scripts/cli.ts).
// It runs without @inquirer/prompts and is suitable for postinstall hooks.

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

const MCP_NAME = "kevlar";

function getClaudeConfigPath(): string {
  const H = os.homedir();
  if (process.platform === "darwin") {
    return path.join(H, "Library/Application Support/Claude/claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return path.join(H, "AppData/Roaming/Claude/claude_desktop_config.json");
  }
  // Linux: Claude Desktop currently not officially supported, but try common path
  return "";
}

async function setup() {
  console.log("🛡️  Setting up Kevlar MCP Server (Zero-Config)...");

  const projectDir = process.cwd();

  // ── 1. Install dependencies ──────────────────────────────────
  console.log("> Installing dependencies (npm install)...");
  try {
    execSync("npm install", { stdio: "inherit" });
  } catch {
    console.error(
      "❌ Dependency installation failed. Please ensure Node.js and npm are installed."
    );
    return;
  }

  // ── 2. Build TypeScript ───────────────────────────────────────
  console.log("> Compiling TypeScript (npm run build)...");
  try {
    execSync("npm run build", { stdio: "inherit" });
  } catch {
    console.error(
      "❌ Build failed. Please check your TypeScript configuration and try again."
    );
    return;
  }

  // ── 3. Inject Claude Desktop config ──────────────────────────
  const configPath = getClaudeConfigPath();

  if (!configPath) {
    console.log(
      "ℹ️  Automatic configuration for Claude Desktop is not supported on this platform."
    );
    console.log("   Please follow the manual setup instructions in the README.");
  } else {
    console.log(`> Injecting MCP configuration into:\n  ${configPath}`);

    if (!fs.existsSync(configPath)) {
      console.log(
        "ℹ️  Claude Desktop configuration file not found. Is Claude Desktop installed?"
      );
      console.log("   Skipping auto-injection. You can run this script again after installing Claude Desktop.");
    } else {
      try {
        const raw    = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw);

        if (!config.mcpServers) config.mcpServers = {};

        // Point directly at the compiled entry point
        const distEntry = path.join(projectDir, "dist/index.js");
        const entry = {
          command: "node",
          args: [distEntry],
        };

        // Idempotency check
        if (JSON.stringify(config.mcpServers[MCP_NAME]) === JSON.stringify(entry)) {
          console.log("✅ MCP configuration is already up to date. Nothing to do.");
        } else {
          config.mcpServers[MCP_NAME] = entry;

          // Write with atomic-style temp file to avoid corrupt config on crash
          const tmp = configPath + ".tmp";
          fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
          fs.renameSync(tmp, configPath);

          console.log("✅ MCP configuration injected successfully!");
        }
      } catch (e: any) {
        console.error(`❌ Configuration file update failed: ${e.message}`);
        console.error(
          "   Please set up manually by editing the config file as described in the README."
        );
      }
    }
  }

  // ── 4. Done ───────────────────────────────────────────────────
  console.log("\n🎉 Kevlar is ready!");
  console.log(
    "   Fully quit and restart Claude Desktop, then say to the AI:"
  );
  console.log(
    '\x1b[36m%s\x1b[0m',
    '   "Help me stress-test my content with Kevlar."'
  );
}

setup();
