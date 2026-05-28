#!/usr/bin/env node
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { select, input } from "@inquirer/prompts";
import chalk from "chalk";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

// ── Constants & Branding ─────────────────────────────────────────

const DIM   = chalk.gray;
const GREEN = chalk.greenBright;
const RED   = chalk.red;
const CYAN  = chalk.cyan;
const BRAND = chalk.hex("#FFD700"); // Kevlar-4u gold

const MCP_NAME    = "kevlar-4u";
const GITHUB_REPO = "9Churze/kevlar-4u";

// Resolve package version from nearest package.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findPackageJson(startDir: string): any {
  let curr = startDir;
  while (curr !== path.parse(curr).root) {
    const pkgPath = path.join(curr, "package.json");
    if (fs.existsSync(pkgPath)) {
      return { ...JSON.parse(fs.readFileSync(pkgPath, "utf8")), __path: pkgPath };
    }
    curr = path.dirname(curr);
  }
  return {};
}

const pkg     = findPackageJson(__dirname);
const VERSION = pkg.version || "1.0.0";

// ── i18n Support ──────────────────────────────────────────────────

type SupportedLanguage = "zh-CN" | "en-US";

const CLI_STRINGS: Record<SupportedLanguage, Record<string, string>> = {
  "zh-CN": {
    banner: "🛡️  内容压力测试盔甲",
    useCaseTitle: "适合这样的你",
    useCase1Title: "📝  自媒体 · 内容创作者",
    useCase1Desc: "      发帖前模拟真实读者反应，检测文案是否说清楚了产品价值",
    useCase2Title: "📰  公关 · 舆情红队",
    useCase2Desc: "      发布声明、通稿前预扫舆论雷区，扮演挑剔记者、对立视角",
    useCase3Title: "📱  产品评测",
    useCase3Desc: "      模拟参数党、品牌粉、性价比警察，预检评测公正性",
    useCase4Title: "🎬  编剧 · 剧本杀",
    useCase4Desc: "      测试剧情漏洞、角色动机、玩家体验，提前拆弹",
    startInstall: "按 Enter 开始安装，或 Cancel 退出",
    installGo: "▶  开始安装 Kevlar-4u 服务",
    scanning: "正在扫描已安装的 AI 客户端...",
    detected: "已检测到",
    notFound: "未找到",
    supported: "支持的客户端：Claude Desktop, Cursor, Windsurf, OpenCode, Codex, Antigravity, CodeBuddy, WorkBuddy",
    manualSetup: "手动配置",
    noClients: "未检测到支持的 AI 客户端。",
    configurePrompt: "是否配置检测到的客户端？",
    configureYes: "是，注入 Kevlar-4u 配置",
    configured: "已配置",
    alreadyConfigured: "已配置（跳过）",
    backup: "备份",
    restartHint: "重启你的 AI 客户端，然后说：",
    installComplete: "安装完成",
    installCancelled: "安装已取消。下次运行：npm run kevlar-4u",
    reportError: "是否将错误报告到 GitHub？",
    reportYes: "是，打开 GitHub Issue",
    reportNo: "否，谢谢",
    langSelect: "选择界面语言：",
    langZhCN: "简体中文",
    langEnUS: "English",
    langPrompt: "选择语言后按 Enter 继续",
  },
  "en-US": {
    banner: "🛡️  Content Stress-Test Armor",
    useCaseTitle: "Perfect for you if you are",
    useCase1Title: "📝  Content Creator",
    useCase1Desc: "      Simulate real reader reactions before posting",
    useCase2Title: "📰  PR / Crisis Management",
    useCase2Desc: "      Scan for potential PR risks before publishing statements",
    useCase3Title: "📱  Product Reviewer",
    useCase3Desc: "      Simulate different reviewer perspectives",
    useCase4Title: "🎬  Scriptwriter",
    useCase4Desc: "      Test plot holes, character motivations, player experience",
    startInstall: "Press Enter to start installation, or Cancel to exit",
    installGo: "▶  Install Kevlar-4u Service",
    scanning: "Scanning for installed AI clients...",
    detected: "detected",
    notFound: "Not found",
    supported: "Supported: Claude Desktop, Cursor, Windsurf, OpenCode, Codex, Antigravity, CodeBuddy, WorkBuddy",
    manualSetup: "Manual setup",
    noClients: "No supported AI clients detected on this machine.",
    configurePrompt: "Configure detected clients?",
    configureYes: "Yes, inject Kevlar-4u config",
    configured: "configured",
    alreadyConfigured: "already configured",
    backup: "backup",
    restartHint: "Restart your AI client, then say:",
    installComplete: "Installation complete",
    installCancelled: "Installation cancelled. Run again: npm run kevlar-4u",
    reportError: "Report these errors to GitHub?",
    reportYes: "Yes, open GitHub issue",
    reportNo: "No thanks",
    langSelect: "Select interface language:",
    langZhCN: "简体中文",
    langEnUS: "English",
    langPrompt: "Select language and press Enter to continue",
  },
};

let currentLang: SupportedLanguage = "zh-CN";

function t(key: string): string {
  return CLI_STRINGS[currentLang][key] || key;
}

function loadSavedLanguage(): SupportedLanguage {
  const configPath = path.join(os.homedir(), ".kevlar-lang");
  try {
    if (fs.existsSync(configPath)) {
      const saved = fs.readFileSync(configPath, "utf8").trim();
      if (saved === "zh-CN" || saved === "en-US") return saved;
    }
  } catch {}
  return "zh-CN";
}

function saveLanguage(lang: SupportedLanguage): void {
  const configPath = path.join(os.homedir(), ".kevlar-lang");
  try {
    fs.writeFileSync(configPath, lang, "utf8");
  } catch {}
}

// ── MCP stdio pass-through mode ──────────────────────────────────
// When Claude Desktop spawns this file as an MCP server it passes --stdio.
// We forward to the compiled entry point instead of rendering the CLI.

if (process.argv.includes("--stdio")) {
  const projectRoot = pkg.__path
    ? path.dirname(pkg.__path)
    : path.resolve(__dirname, "..");

  const serverPath = fs.existsSync(path.join(projectRoot, "dist/index.js"))
    ? path.join(projectRoot, "dist/index.js")
    : path.join(projectRoot, "src/index.ts");

  const child = spawn("node", [serverPath, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  runCLI().catch((err) => {
    console.error(RED(`\n  Fatal error: ${err.message}`));
    process.exit(1);
  });
}

// ── Types ────────────────────────────────────────────────────────

import { getRegistry, type ClientDef } from "./registry.js";

interface InjectResult {
  ok: boolean;
  status: "updated" | "skipped" | "error" | "unsupported";
  errorType?: string;
  message?: string;
  backupPath?: string;
}

// ── Utilities ────────────────────────────────────────────────────

function sanitisePath(p: string): string {
  return p.replace(os.homedir(), "~");
}

function escapeRegex(str: string): string {
  return str.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&");
}

async function detectClient(client: ClientDef): Promise<boolean> {
  if (client.unsupported) return false;
  try {
    const candidates = client.detectPaths
      ? client.detectPaths()
      : [path.dirname(client.configPath())];

    const validPaths = candidates.filter(Boolean);
    if (validPaths.length === 0) return false;

    for (const p of validPaths) {
      if (fs.existsSync(p)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function readJson(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`malformed-json: ${(err as Error).message}`);
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, filePath);
}

function backupIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const bak = filePath + ".bak";
    fs.copyFileSync(filePath, bak);
    return bak;
  } catch {
    return null;
  }
}

// ── Entry builder ────────────────────────────────────────────────

function getMcpEntry(
  client: ClientDef,
  cmd: string,
  args: string[]
): Record<string, unknown> {
  // OpenCode local format uses a specific structure
  if (client.format === "json-mcp-local" && cmd !== "npx") {
    return {
      type: "local",
      command: [cmd, ...args],
      enabled: true,
    };
  }

  const entry: Record<string, unknown> = { command: cmd, args };
  if (client.requiresStdioType) entry.type = "stdio";
  return entry;
}

// ── TOML merge ───────────────────────────────────────────────────

function mergeTomlBlock(
  existing: string,
  cmd: string,
  args: string[]
): { content: string; changed: boolean } {
  const block =
    `[mcp_servers."${MCP_NAME}"]\n` +
    `command = "${cmd}"\n` +
    `args = [${args.map((a) => `"${a}"`).join(", ")}]`;

  const pattern = new RegExp(
    `\\[mcp_servers\\."${escapeRegex(MCP_NAME)}"\\][\\s\\S]*?(?=\\r?\\n\\s*\\[|$)`,
    "g"
  );

  const match = existing.match(pattern);
  if (match && match[0].trim() === block.trim()) {
    return { content: existing, changed: false };
  }

  const updated = match
    ? existing.replace(pattern, block)
    : existing.trimEnd() + (existing.trim() ? "\n\n" : "") + block + "\n";

  return { content: updated, changed: true };
}

// ── Core injection engine ────────────────────────────────────────

async function injectConfig(
  client: ClientDef,
  opts: { cmd: string; args: string[] }
): Promise<InjectResult> {
  if (client.unsupported) return { ok: false, status: "unsupported" };

  const configPath = client.configPath();
  if (!configPath) return { ok: false, status: "error", errorType: "no-path" };

  // ── TOML flow (Codex) ────────────────────────────────────────
  if (client.format === "toml-mcp") {
    try {
      await fsp.mkdir(path.dirname(configPath), { recursive: true });
      const raw = fs.existsSync(configPath)
        ? await fsp.readFile(configPath, "utf8")
        : "";
      const { content, changed } = mergeTomlBlock(raw, opts.cmd, opts.args);
      if (!changed) return { ok: true, status: "skipped" };
      const backupPath = backupIfExists(configPath) ?? undefined;
      await writeAtomic(configPath, content);
      return { ok: true, status: "updated", backupPath };
    } catch (err) {
      return {
        ok: false,
        status: "error",
        errorType: "write-error",
        message: (err as Error).message,
      };
    }
  }

  // ── JSON flow ────────────────────────────────────────────────
  let config: any;
  try {
    config = readJson(configPath) ?? {};
  } catch (err) {
    const msg = (err as Error).message;
    return {
      ok: false,
      status: "error",
      errorType: msg.startsWith("malformed-json") ? "malformed-json" : "read-error",
      message: msg,
    };
  }

  const rootKey =
    client.format === "json-mcp" || client.format === "json-mcp-local"
      ? "mcp"
      : "mcpServers";

  const newEntry      = getMcpEntry(client, opts.cmd, opts.args);
  const existingEntry = config[rootKey]?.[MCP_NAME];

  // Idempotency: skip if identical
  if (JSON.stringify(existingEntry) === JSON.stringify(newEntry)) {
    return { ok: true, status: "skipped" };
  }

  const backupPath   = backupIfExists(configPath) ?? undefined;
  const updatedConfig = {
    ...config,
    [rootKey]: {
      ...(config[rootKey] ?? {}),
      [MCP_NAME]: newEntry,
    },
  };

  try {
    await writeAtomic(configPath, JSON.stringify(updatedConfig, null, 2) + "\n");
    return { ok: true, status: "updated", backupPath };
  } catch (err) {
    return {
      ok: false,
      status: "error",
      errorType: "write-error",
      message: (err as Error).message,
      backupPath,
    };
  }
}

// ── GitHub issue helper ──────────────────────────────────────────

function openGitHubIssue(report: {
  client: string;
  platform: string;
  errorType?: string;
  message?: string;
  installerVersion: string;
}): void {
  const title = encodeURIComponent(
    `[auto] Install error — ${report.client} on ${report.platform}`
  );
  const body = encodeURIComponent(
    `**Client**: ${report.client}\n` +
    `**Platform**: ${report.platform}\n` +
    `**Error**: ${report.errorType}\n` +
    `**Message**: ${report.message}\n` +
    `**Installer version**: ${report.installerVersion}\n\n` +
    `*(Pre-filled by the installer. No personal data included.)*`
  );
  const url = `https://github.com/${GITHUB_REPO}/issues/new?title=${title}&body=${body}&labels=install-error`;
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32"  ? "start" :
    "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

// ── CLI UI ───────────────────────────────────────────────────────

async function runCLI() {
  const isRemoteRun =
    __dirname.includes("node_modules") || __dirname.includes("_npx");

  const projectRoot = pkg.__path
    ? path.dirname(pkg.__path)
    : path.resolve(__dirname, "..");

  // Resolve the command that the AI client will use to launch Kevlar-4u
  const { cmd, args } = isRemoteRun
    ? { cmd: "npx", args: ["-y", "kevlar-4u@latest", "--stdio"] }
    : {
        cmd: "node",
        args: [
          fs.existsSync(path.join(projectRoot, "dist/index.js"))
            ? path.join(projectRoot, "dist/index.js")
            : path.join(projectRoot, "src/index.ts"),
          "--stdio",
        ],
      };

  const registry = getRegistry();

  // ── Language Selection ──────────────────────────────────────────
  console.clear();
  
  const savedLang = loadSavedLanguage();
  
  console.log(`
  ${BRAND.bold("██╗  ██╗███████╗██╗   ██╗██╗      █████╗ ██████╗ ")}
  ${BRAND.bold("██║ ██╔╝██╔════╝██║   ██║██║     ██╔══██╗██╔══██╗")}
  ${BRAND.bold("█████╔╝ █████╗  ██║   ██║██║     ███████║██████╔╝")}
  ${BRAND.bold("██╔═██╗ ██╔══╝  ╚██╗ ██╔╝██║     ██╔══██║██╔══██╗")}
  ${BRAND.bold("██║  ██╗███████╗ ╚████╔╝ ███████╗██║  ██║██║  ██║")}
  ${BRAND.bold("╚═╝  ╚═╝╚══════╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝")}

  ${BRAND("🛡️  Content Stress-Test Armor")} ${DIM("｜")} ${DIM("v" + VERSION)}
  `);

  const langChoice = await select({
    message: `  ${CYAN("λ")} Select interface language / 选择界面语言：`,
    choices: [
      { name: "🇨🇳  简体中文", value: "zh-CN" as SupportedLanguage },
      { name: "🇺🇸  English", value: "en-US" as SupportedLanguage },
    ],
    default: savedLang,
  });

  currentLang = langChoice;
  saveLanguage(langChoice);

  console.clear();
  console.log(`
  ${BRAND.bold("██╗  ██╗███████╗██╗   ██╗██╗      █████╗ ██████╗ ")}
  ${BRAND.bold("██║ ██╔╝██╔════╝██║   ██║██║     ██╔══██╗██╔══██╗")}
  ${BRAND.bold("█████╔╝ █████╗  ██║   ██║██║     ███████║██████╔╝")}
  ${BRAND.bold("██╔═██╗ ██╔══╝  ╚██╗ ██╔╝██║     ██╔══██║██╔══██╗")}
  ${BRAND.bold("██║  ██╗███████╗ ╚████╔╝ ███████╗██║  ██║██║  ██║")}
  ${BRAND.bold("╚═╝  ╚═╝╚══════╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝")}

  ${BRAND(t("banner"))} ${DIM("｜")} ${DIM("v" + VERSION)}
  `);

  // ── Use case showcase ──────────────────────────────────────────

  console.log(`
  ${chalk.bold(t("useCaseTitle"))}

  ${DIM(t("useCase1Title"))}
  ${DIM(t("useCase1Desc"))}

  ${DIM(t("useCase2Title"))}
  ${DIM(t("useCase2Desc"))}

  ${DIM(t("useCase3Title"))}
  ${DIM(t("useCase3Desc"))}

  ${DIM(t("useCase4Title"))}
  ${DIM(t("useCase4Desc"))}
  `);

  console.log(
    `  ${DIM("━".repeat(48))}\n`
  );

  const proceed = await select({
    message: `  ${CYAN("λ")} ${t("startInstall")}`,
    choices: [
      { name: `${GREEN("▶")}  ${t("installGo")}`, value: "go" },
      { name: currentLang === "zh-CN" ? "取消" : "Cancel", value: "cancel" },
    ],
  });

  if (proceed === "cancel") {
    console.log(DIM(`\n  ${t("installCancelled")}\n`));
    process.exit(0);
  }

  console.log(`  ${CYAN("→")} ${t("scanning")}\n`);

  const detectionResults = await Promise.all(
    registry.map(async (c) => ({ client: c, found: await detectClient(c) }))
  );

  const found    = detectionResults.filter((r) => r.found).map((r) => r.client);
  const notFound = registry.filter((c) => !found.includes(c) && !c.unsupported);

  if (found.length === 0) {
    console.log(chalk.yellow(`  ${t("noClients")}\n`));
    console.log(DIM(`  ${t("supported")}`));
    console.log(DIM(`  ${t("manualSetup")}: https://github.com/${GITHUB_REPO}\n`));
    process.exit(0);
  }

  for (const c of found) {
    console.log(`  ${GREEN("✓")} ${chalk.bold(c.label)} ${DIM(t("detected"))}`);
  }
  if (notFound.length > 0) {
    console.log(`  ${DIM(t("notFound") + ": " + notFound.map((c) => c.label).join(", "))}`);
  }

  console.log();

  const confirm = await select({
    message: `  ${CYAN("λ")} ${chalk.bold("KEVLAR")} ${DIM("»")} ${t("configurePrompt")}`,
    choices: [
      { name: `🛡️  ${t("configureYes")}`, value: "go" },
      { name: currentLang === "zh-CN" ? "取消" : "Cancel", value: "cancel" },
    ],
  });

  if (confirm === "cancel") process.exit(0);

  console.log();

  const errors: Array<{ client: ClientDef; result: InjectResult }> = [];

  for (const client of found) {
    const result = await injectConfig(client, { cmd, args });

    if (result.ok) {
      const statusIcon = result.status === "skipped" ? DIM("○") : GREEN("✓");
      const statusText =
        result.status === "skipped" ? DIM(t("alreadyConfigured")) : t("configured");
      const backupNote =
        result.backupPath
          ? DIM(` (${t("backup")}: ${sanitisePath(result.backupPath)})`)
          : "";
      console.log(
        `  ${statusIcon}  ${chalk.bold(client.label)} ${statusText}${backupNote}`
      );
    } else {
      console.log(
        `  ${RED("✗")}  ${chalk.bold(client.label)} — ${RED(result.errorType ?? (currentLang === "zh-CN" ? "未知错误" : "unknown error"))}`
      );
      errors.push({ client, result });
    }
  }

  if (errors.length > 0) {
    console.log(chalk.yellow(`\n  ${currentLang === "zh-CN" ? "部分客户端无法自动配置。" : "Some clients could not be configured automatically."}`));
    const report = await select({
      message: `  ${t("reportError")}`,
      choices: [
        { name: `  ${t("reportYes")}`, value: "yes" },
        { name: `  ${t("reportNo")}`, value: "no" },
      ],
    });

    if (report === "yes") {
      for (const { client, result } of errors) {
        openGitHubIssue({
          client: client.label,
          platform: `${process.platform} / Node ${process.version}`,
          errorType: result.errorType,
          message: sanitisePath(result.message ?? ""),
          installerVersion: VERSION,
        });
      }
    }
  } else {
    console.log(
      `\n  ${GREEN.bold(t("installComplete"))} 🛡️  ${t("restartHint")}\n`
    );
    console.log(
      `  ${chalk.cyan(currentLang === "zh-CN" ? '"帮我用 Kevlar-4u 压力测试一下我的内容。"' : '"Help me stress-test my content with Kevlar-4u."')}\n`
    );
  }
}
