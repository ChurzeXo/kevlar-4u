#!/usr/bin/env node
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { select, input } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import readline from "readline";

// ── Constants & Branding ─────────────────────────────────────────

const DIM = chalk.gray;
const GREEN = chalk.greenBright;
const RED = chalk.red;
const CYAN = chalk.cyan;
const GOLD = chalk.hex("#FFD700");
const AMBER = chalk.hex("#FFBF00");
const ORANGE = chalk.hex("#FF8C00");

const MCP_NAME = "kevlar-4u";
const GITHUB_REPO = "ChurzeXo/kevlar-4u";

// Resolve package version from nearest package.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const currentScriptPath = fileURLToPath(import.meta.url);
const compiledEntryPath = path.resolve(__dirname, "..", "dist", "scripts", "cli.js");

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

const pkg = findPackageJson(__dirname);
const VERSION = pkg.version || "1.0.0";

// ── Gradient helpers ─────────────────────────────────────────────

function gradientText(text: string): string {
  const colors = [
    "#FFD700",
    "#F5C800",
    "#EDB900",
    "#E5AA00",
    "#DD9B00",
    "#D58C00",
    "#CD7D00",
    "#C56E00",
    "#BD5F00",
    "#B55000",
    "#AD4100",
    "#A53200",
  ];
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const color = colors[i % colors.length];
    result += chalk.hex(color)(text[i]);
  }
  return result;
}

// ── ASCII Logo ───────────────────────────────────────────────────

const ASCII_LOGO = [
  " KK  KK  EEEEE  V     V  L        AAA    RRRR    4444    U   U ",
  " KK KK   EE      V   V   L       A   A   R   R   4  4    U   U ",
  " KKKK    EEEE     V V    L       AAAAA   RRRR    4444    U   U ",
  " KK KK   EE        V     L       A   A   R  R       4    U   U ",
  " KK  KK  EEEEE     V     LLLLL   A   A   R   R      4     UUU  ",
];

const LOGO_WIDTH = Math.max(...ASCII_LOGO.map((line) => strWidth(line)));

function renderLogo(): string {
  const padding = centerPad();

  const lines = ASCII_LOGO.map((line, i) => {
    const color = i < 2 ? GOLD : i < 4 ? AMBER : ORANGE;
    return `${padding}${color(line)}`;
  });
  return lines.join("\n");
}

// ── i18n Support ──────────────────────────────────────────────────

type SupportedLanguage = "zh-CN" | "en-US";

const CLI_STRINGS: Record<SupportedLanguage, Record<string, string>> = {
  "zh-CN": {
    banner: "🛡️  内容压力测试盔甲",
    useCaseTitle: "适合这样的你",
    useCase1Title: "📝  自媒体 · 内容创作者",
    useCase1Desc: "发帖前模拟真实读者反应，检测文案是否说清楚了产品价值",
    useCase2Title: "📰  公关 · 舆情红队",
    useCase2Desc: "发布声明、通稿前预扫舆论雷区，扮演挑剔记者、对立视角",
    useCase3Title: "📱  产品评测",
    useCase3Desc: "模拟参数党、品牌粉、性价比警察，预检评测公正性",
    useCase4Title: "🎬  编剧 · 剧本杀",
    useCase4Desc: "测试剧情漏洞、角色动机、玩家体验，提前拆弹",
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
    useCase1Desc: "Simulate real reader reactions before posting",
    useCase2Title: "📰  PR / Crisis Management",
    useCase2Desc: "Scan for potential PR risks before publishing statements",
    useCase3Title: "📱  Product Reviewer",
    useCase3Desc: "Simulate different reviewer perspectives",
    useCase4Title: "🎬  Scriptwriter",
    useCase4Desc: "Test plot holes, character motivations, player experience",
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

// ── Dashboard UI helpers ─────────────────────────────────────────

const PW = 78; // panel content width

function strWidth(s: string): number {
  let w = 0;
  const chars = [...s.replace(/\u001b\[[\d;]*m/g, "")];
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0)!;
    // Regional Indicator Symbols (🇨🇳 🇺🇸 etc.): count pairs as width 2
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
      const nextCp = i + 1 < chars.length ? chars[i + 1].codePointAt(0)! : 0;
      if (nextCp >= 0x1f1e6 && nextCp <= 0x1f1ff) {
        w += 2;
        i++; // skip next
        continue;
      }
      w += 2;
      continue;
    }
    if (cp >= 0x4e00 && cp <= 0x9fff) w += 2;
    else if (cp >= 0x3400 && cp <= 0x4dbf) w += 2;
    else if (cp >= 0x3000 && cp <= 0x303f) w += 2;
    else if (cp >= 0x3040 && cp <= 0x30ff) w += 2;
    else if (cp >= 0xac00 && cp <= 0xd7af) w += 2;
    else if (cp >= 0xff01 && cp <= 0xff60) w += 2;
    else if (cp >= 0x1f000 && cp <= 0x1ffff) w += 2;
    else if (cp >= 0xfe00 && cp <= 0xfe0f) {
    } else if (cp === 0x200d) {
    } // ZWJ
    else w += 1;
  }
  return w;
}

function centerPad(): string {
  return "  ";
}

// Double-line borders for title panels
function doubleBoxTop(title: string): string {
  const right = PW - strWidth(title) - 3;
  return `${centerPad()}╔═ ${title} ${"═".repeat(Math.max(0, right))}╗`;
}

function doubleBoxMid(content: string): string {
  const lines = content.split("\n");
  return lines
    .map((l) => {
      const visible = strWidth(l);
      return `${centerPad()}║ ${l}${" ".repeat(Math.max(0, PW - visible - 1))}║`;
    })
    .join("\n");
}

function doubleBoxBottom(): string {
  return `${centerPad()}╚${"═".repeat(PW)}╝`;
}

// Single-line borders for content panels
function boxTop(title: string): string {
  const right = PW - strWidth(title) - 3;
  return `${centerPad()}┌─ ${title} ${"─".repeat(Math.max(0, right))}┐`;
}

function boxMid(content: string): string {
  const lines = content.split("\n");
  return lines
    .map((l) => {
      const visible = strWidth(l);
      return `${centerPad()}│ ${l}${" ".repeat(Math.max(0, PW - visible - 1))}│`;
    })
    .join("\n");
}

function boxBottom(): string {
  return `${centerPad()}└${"─".repeat(PW)}┘`;
}

function dashHeader(registrySize: number): string {
  // Calculate column widths based on PW
  const innerWidth = PW; // width inside the ║ ║
  const midX = Math.floor(innerWidth / 2);

  function pad(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - strWidth(text)));
  }

  const l1 = pad(`${chalk.bold("Platform")}  ${process.platform} ${os.release()}`, midX);
  const r1 = pad(`${chalk.bold("Clients")}  ${registrySize}`, innerWidth - midX - 1);
  const l2 = pad(`${chalk.bold("Runtime")}  Node ${process.version}`, midX);
  const r2 = pad(
    `${chalk.bold("Mode")}     ${__dirname.includes("node_modules") ? "npx" : "local"}`,
    innerWidth - midX - 1,
  );

  const bannerText = t("banner");
  const ke4uPart = `  ${GOLD.bold("KEVLAR-4U")}  ${DIM("v" + VERSION)}  `;
  const hdrContent = ke4uPart + bannerText;
  const hdrPad = " ".repeat(Math.max(0, innerWidth - strWidth(hdrContent)));

  const rule = "═".repeat(PW);
  const cp = centerPad();
  return (
    [
      `\n${cp}${GOLD("╔" + rule + "╗")}`,
      `${cp}${GOLD("║")}${GOLD(hdrContent)}${hdrPad}${GOLD("║")}`,
      `${cp}${DIM("╠" + rule + "╣")}`,
      `${cp}${DIM("║")}${l1}${DIM("│")}${r1}${DIM("║")}`,
      `${cp}${DIM("║")}${l2}${DIM("│")}${r2}${DIM("║")}`,
      `${cp}${GOLD("╚" + rule + "╝")}`,
    ].join("\n") + "\n"
  );
}

function useCasePanel(): string {
  const items = [
    { t: t("useCase1Title"), d: t("useCase1Desc") },
    { t: t("useCase2Title"), d: t("useCase2Desc") },
    { t: t("useCase3Title"), d: t("useCase3Desc") },
    { t: t("useCase4Title"), d: t("useCase4Desc") },
  ];

  // Each use case as a row with icon separator
  const rows = items.map((item) => {
    return `${chalk.bold(item.t)}\n  ${DIM(item.d.trimStart())}`;
  });

  // Add extra spacing between title and content
  const content = "\n" + rows.join("\n\n");

  return [doubleBoxTop(t("useCaseTitle")), doubleBoxMid(content), doubleBoxBottom()].join("\n");
}

function scanPanel(found: ClientDef[], notFound: ClientDef[]): string {
  const rows: string[] = [];
  for (const c of found) {
    rows.push(`${GREEN("✓")}  ${chalk.bold(c.label)}  ${DIM(t("detected"))}`);
  }
  if (notFound.length > 0) {
    for (const c of notFound) {
      rows.push(`${DIM("○")}  ${chalk.bold(c.label)}  ${DIM(t("notFound"))}`);
    }
  }
  return [doubleBoxTop("Scan Results"), doubleBoxMid(rows.join("\n")), doubleBoxBottom()].join("\n");
}

function injectPanel(results: Array<{ client: ClientDef; result: InjectResult }>): {
  panel: string;
  errors: Array<{ client: ClientDef; result: InjectResult }>;
} {
  const rows: string[] = [];
  const errs: Array<{ client: ClientDef; result: InjectResult }> = [];

  for (const { client, result } of results) {
    if (result.ok) {
      const icon = result.status === "skipped" ? DIM("○") : GREEN("✓");
      const text = result.status === "skipped" ? DIM(t("alreadyConfigured")) : t("configured");
      const note = result.backupPath ? DIM(` (${t("backup")}: ${sanitisePath(result.backupPath)})`) : "";
      rows.push(`${icon}  ${chalk.bold(client.label)}  ${text}${note}`);
    } else {
      rows.push(
        `${RED("✗")}  ${chalk.bold(client.label)}  ${RED(result.errorType ?? (currentLang === "zh-CN" ? "未知错误" : "unknown error"))}`,
      );
      errs.push({ client, result });
    }
  }
  return {
    panel: [doubleBoxTop("Injection Results"), doubleBoxMid(rows.join("\n")), doubleBoxBottom()].join("\n"),
    errors: errs,
  };
}

// ── Mode dispatch ──────────────────────────────────────────────
// --activate [--code <code>]  activate Pro license
// --status                   show Free/Pro status
// --logout                   clear stored credentials
// --sync                     sync strategy bundle from server
// --doctor                   run diagnostics
// --auto                     silent install (for AI-invoked setup)
// --stdio                    MCP server mode (spawns the compiled server)
// (no flag)                  interactive install wizard

if (process.argv.includes("--activate")) {
  const codeIndex = process.argv.indexOf("--code");
  const code = codeIndex !== -1 ? process.argv[codeIndex + 1] : undefined;
  runActivate(code).catch((err) => {
    console.error(`[Kevlar-4u] Activation failed: ${err.message}`);
    process.exit(1);
  });
} else if (process.argv.includes("--status")) {
  runStatus();
} else if (process.argv.includes("--logout")) {
  runLogout().catch((err) => {
    console.error(`[Kevlar-4u] Logout failed: ${err.message}`);
    process.exit(1);
  });
} else if (process.argv.includes("--sync")) {
  runSync().catch((err) => {
    console.error(`[Kevlar-4u] Sync failed: ${err.message}`);
    process.exit(1);
  });
} else if (process.argv.includes("--doctor")) {
  runDoctor().catch((err) => {
    console.error(`[Kevlar-4u] Doctor failed: ${err.message}`);
    process.exit(1);
  });
} else if (process.argv.includes("--stdio")) {
  const projectRoot = pkg.__path ? path.dirname(pkg.__path) : path.resolve(__dirname, "..");

  const serverPath = path.join(projectRoot, "dist", "index.js");
  if (!fs.existsSync(serverPath)) {
    console.error("[Kevlar-4u] dist/index.js not found. Run `npm run build` first.");
    process.exit(1);
  }

  const child = spawn("node", [serverPath, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else if (process.argv.includes("--auto")) {
  runAutoInstall().catch((err) => {
    console.error(`[Kevlar-4u] Fatal: ${err.message}`);
    process.exit(1);
  });
} else {
  runCLI().catch((err) => {
    console.error(`${centerPad()}${RED(`\n  Fatal error: ${err.message}`)}`);
    process.exit(1);
  });
}

// ── Types ────────────────────────────────────────────────────────

import { getRegistry, type ClientDef } from "./registry.js";
import { runActivate, runStatus, runLogout, runDoctor, runSync } from "./credentialCli.js";

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
    const candidates = client.detectPaths ? client.detectPaths() : [path.dirname(client.configPath())];

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

function getMcpEntry(client: ClientDef, cmd: string, args: string[]): Record<string, unknown> {
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

function mergeTomlBlock(existing: string, cmd: string, args: string[]): { content: string; changed: boolean } {
  const block =
    `[mcp_servers."${MCP_NAME}"]\n` + `command = "${cmd}"\n` + `args = [${args.map((a) => `"${a}"`).join(", ")}]`;

  const pattern = new RegExp(`\\[mcp_servers\\."${escapeRegex(MCP_NAME)}"\\][\\s\\S]*?(?=\\r?\\n\\s*\\[|$)`, "g");

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

async function injectConfig(client: ClientDef, opts: { cmd: string; args: string[] }): Promise<InjectResult> {
  if (client.unsupported) return { ok: false, status: "unsupported" };

  const configPath = client.configPath();
  if (!configPath) return { ok: false, status: "error", errorType: "no-path" };

  // ── TOML flow (Codex) ────────────────────────────────────────
  if (client.format === "toml-mcp") {
    try {
      await fsp.mkdir(path.dirname(configPath), { recursive: true });
      const raw = fs.existsSync(configPath) ? await fsp.readFile(configPath, "utf8") : "";
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

  const rootKey = client.format === "json-mcp" || client.format === "json-mcp-local" ? "mcp" : "mcpServers";

  const newEntry = getMcpEntry(client, opts.cmd, opts.args);
  const existingEntry = config[rootKey]?.[MCP_NAME];

  // Idempotency: skip if identical
  if (JSON.stringify(existingEntry) === JSON.stringify(newEntry)) {
    return { ok: true, status: "skipped" };
  }

  const backupPath = backupIfExists(configPath) ?? undefined;
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
  const title = encodeURIComponent(`[auto] Install error — ${report.client} on ${report.platform}`);
  const body = encodeURIComponent(
    `**Client**: ${report.client}\n` +
      `**Platform**: ${report.platform}\n` +
      `**Error**: ${report.errorType}\n` +
      `**Message**: ${report.message}\n` +
      `**Installer version**: ${report.installerVersion}\n\n` +
      `*(Pre-filled by the installer. No personal data included.)*`,
  );
  const url = `https://github.com/${GITHUB_REPO}/issues/new?title=${title}&body=${body}&labels=install-error`;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

// ── Dashboard UI helpers ─────────────────────────────────────────
// ── CLI UI ───────────────────────────────────────────────────────

function setupEscapeHandler() {
  readline.emitKeypressEvents(process.stdin);
  const handler = (_str: string, key: readline.Key) => {
    if (key.name === "escape") {
      console.log(`\n\n${centerPad()}${DIM(t("installCancelled"))}\n`);
      process.exit(0);
    }
  };
  process.stdin.on("keypress", handler);
}

// ── Silent auto-install mode ─────────────────────────────────────
// Triggered by --auto flag. No prompts, no fancy UI.
// Designed for AI-invoked setup: "npx -y kevlar-4u --auto"

async function runAutoInstall() {
  currentLang = loadSavedLanguage();
  const isRemoteRun = __dirname.includes("node_modules") || __dirname.includes("_npx");
  const { cmd, args } = isRemoteRun
    ? { cmd: "npx", args: ["-y", "kevlar-4u@latest", "--stdio"] }
    : fs.existsSync(compiledEntryPath)
      ? { cmd: "node", args: [compiledEntryPath, "--stdio"] }
      : { cmd: "npx", args: ["tsx", currentScriptPath, "--stdio"] };

  const registry = getRegistry();

  // Scan (no spinner, no noise)
  const detectionResults = await Promise.all(
    registry.map(async (c) => ({ client: c, found: await detectClient(c) })),
  );
  const found = detectionResults.filter((r) => r.found).map((r) => r.client);

  if (found.length === 0) {
    console.log("[Kevlar-4u] No supported AI clients detected.");
    process.exit(0);
  }

  // Inject
  const results: Array<{ client: ClientDef; result: InjectResult }> = [];
  for (const client of found) {
    const result = await injectConfig(client, { cmd, args });
    results.push({ client, result });
  }

  // Report
  const ok = results.filter((r) => r.result.ok);
  const err = results.filter((r) => !r.result.ok);
  for (const { client, result } of ok) {
    const status = result.status === "skipped" ? "already configured" : "configured";
    console.log(`[Kevlar-4u] ✓ ${client.label} — ${status}`);
    if (result.backupPath) console.log(`         backup: ${sanitisePath(result.backupPath)}`);
  }
  for (const { client, result } of err) {
    console.log(`[Kevlar-4u] ✗ ${client.label} — ${result.errorType ?? "error"}`);
  }

  if (ok.length > 0) {
    console.log("");
    console.log(`[Kevlar-4u] ✅ Installation complete. Restart your AI client, then say:`);
    console.log(`         "${currentLang === "zh-CN" ? "帮我用 Kevlar-4u 压力测试一下我的内容。" : "Help me stress-test my content with Kevlar-4u."}"`);
  }

  process.exit(err.length > 0 ? 1 : 0);
}

async function runCLI() {
  setupEscapeHandler();

  const isRemoteRun = __dirname.includes("node_modules") || __dirname.includes("_npx");

  const projectRoot = pkg.__path ? path.dirname(pkg.__path) : path.resolve(__dirname, "..");

  // The MCP client config points to THIS script with --stdio.
  // When launched with --stdio, the CLI spawns the real server.
  const { cmd, args } = isRemoteRun
    ? { cmd: "npx", args: ["-y", "kevlar-4u@latest", "--stdio"] }
    : fs.existsSync(compiledEntryPath)
      ? { cmd: "node", args: [compiledEntryPath, "--stdio"] }
      : { cmd: "npx", args: ["tsx", currentScriptPath, "--stdio"] };

  const registry = getRegistry();

  // ── Language Selection ──────────────────────────────────────────
  console.clear();

  const savedLang = loadSavedLanguage();

  // Dashboard header (shown once)
  console.log(renderLogo());
  console.log(dashHeader(registry.length));

  // Use cases in a bordered panel
  console.log("\n" + useCasePanel() + "\n");

  // Language selection panel
  const langOptions = `  [1] 🇨🇳  简体中文\n  [2] 🇺🇸  English`;
  console.log(doubleBoxTop(t("langSelect")));
  console.log(doubleBoxMid(langOptions));
  console.log(doubleBoxBottom());

  let langChoice: SupportedLanguage | null = null;
  while (langChoice === null) {
    const raw = await input({
      message: `${centerPad()}${CYAN(">")} `,
      default: savedLang === "zh-CN" ? "1" : "2",
      theme: { prefix: "" },
    });
    const trimmed = raw.trim();
    if (trimmed === "1") langChoice = "zh-CN";
    else if (trimmed === "2") langChoice = "en-US";
    else {
      console.log(`${centerPad()}${RED("✗")}  ${currentLang === "zh-CN" ? "请输入 1 或 2" : "Please enter 1 or 2"}`);
    }
  }

  currentLang = langChoice;
  saveLanguage(langChoice);

  console.clear();

  // Re-render header after language switch
  console.log(renderLogo());
  console.log(dashHeader(registry.length));

  // ── Install prompt ──────────────────────────────────────────────
  const proceed = await select({
    message: `${centerPad()}${CYAN("λ")} ${t("startInstall")}`,
    choices: [
      { name: `${GREEN("▶")}  ${t("installGo")}`, value: "go" },
      { name: currentLang === "zh-CN" ? "取消" : "Cancel", value: "cancel" },
    ],
  });

  if (proceed === "cancel") {
    console.log(`\n${centerPad()}${DIM(t("installCancelled"))}\n`);
    process.exit(0);
  }

  // ── Scan ────────────────────────────────────────────────────────
  const scanSpinner = ora({
    text: `${centerPad()}${t("scanning")}`,
    indent: Math.floor(((process.stdout.columns || 80) - PW) / 2),
    color: "cyan",
  }).start();

  const detectionResults = await Promise.all(registry.map(async (c) => ({ client: c, found: await detectClient(c) })));

  scanSpinner.succeed(`${centerPad()}${t("scanning")} ${GREEN("✓")}`);

  const found = detectionResults.filter((r) => r.found).map((r) => r.client);
  const notFound = registry.filter((c) => !found.includes(c) && !c.unsupported);

  if (found.length === 0) {
    const innerWidth = PW - 2;
    const noClients = t("noClients");
    const supported = t("supported");
    const manualUrl = "https://github.com/" + GITHUB_REPO;
    const manualText = t("manualSetup") + ": " + manualUrl;
    const cp = centerPad();

    console.log(
      [
        `\n${cp}${GOLD("╔" + "═".repeat(PW) + "╗")}`,
        `${cp}${GOLD("║")}  ${chalk.yellow(noClients)}${" ".repeat(Math.max(0, innerWidth - strWidth(noClients) - 2))}${GOLD("║")}`,
        `${cp}${GOLD("║")}  ${DIM(supported)}${" ".repeat(Math.max(0, innerWidth - strWidth(supported) - 2))}${GOLD("║")}`,
        `${cp}${GOLD("║")}  ${DIM(manualText)}${" ".repeat(Math.max(0, innerWidth - strWidth(manualText) - 2))}${GOLD("║")}`,
        `${cp}${GOLD("╚" + "═".repeat(PW) + "╝")}`,
      ].join("\n") + "\n",
    );
    process.exit(0);
  }

  console.log("\n" + scanPanel(found, notFound) + "\n");

  // ── Configure prompt ────────────────────────────────────────────
  const confirm = await select({
    message: `${centerPad()}${CYAN("λ")} ${chalk.bold("KEVLAR-4U")} ${DIM("»")} ${t("configurePrompt")}`,
    choices: [
      { name: `🛡️  ${t("configureYes")}`, value: "go" },
      { name: currentLang === "zh-CN" ? "取消" : "Cancel", value: "cancel" },
    ],
  });

  if (confirm === "cancel") process.exit(0);

  // ── Inject ──────────────────────────────────────────────────────
  const injectResults: Array<{ client: ClientDef; result: InjectResult }> = [];

  const injectSpinner = ora({
    text: `${centerPad()}${currentLang === "zh-CN" ? "正在注入配置..." : "Injecting config..."}`,
    indent: Math.floor(((process.stdout.columns || 80) - PW) / 2),
    color: "cyan",
  }).start();

  for (const client of found) {
    injectSpinner.text = `${centerPad()}${currentLang === "zh-CN" ? "正在注入配置..." : "Injecting config..."} ${chalk.bold(client.label)}`;
    const result = await injectConfig(client, { cmd, args });
    injectResults.push({ client, result });
  }

  injectSpinner.succeed(
    `${centerPad()}${currentLang === "zh-CN" ? "配置注入完成" : "Config injection complete"} ${GREEN("✓")}`,
  );

  const { panel: injectPanelTxt, errors } = injectPanel(injectResults);
  console.log("\n" + injectPanelTxt + "\n");

  if (errors.length > 0) {
    console.log(
      `\n${centerPad()}${chalk.yellow(currentLang === "zh-CN" ? "部分客户端无法自动配置。" : "Some clients could not be configured automatically.")}`,
    );
    const report = await select({
      message: `${centerPad()}${t("reportError")}`,
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
    const completeMsg = GREEN.bold(t("installComplete"));
    const restartMsg = t("restartHint");
    const exampleMsg =
      currentLang === "zh-CN"
        ? '"帮我用 Kevlar-4u 压力测试一下我的内容。"'
        : '"Help me stress-test my content with Kevlar-4u."';

    const innerWidth = PW - 2;
    const line1 = `  ${completeMsg} 🛡️  ${restartMsg}`;
    const line2 = `  ${CYAN(exampleMsg)}`;
    const cp = centerPad();

    console.log(
      [
        `\n${cp}${GOLD("╔" + "═".repeat(PW) + "╗")}`,
        `${cp}${GOLD("║")}${line1}${" ".repeat(Math.max(0, innerWidth - strWidth(line1)))}${GOLD("║")}`,
        `${cp}${GOLD("║")}${line2}${" ".repeat(Math.max(0, innerWidth - strWidth(line2)))}${GOLD("║")}`,
        `${cp}${GOLD("╚" + "═".repeat(PW) + "╝")}`,
      ].join("\n") + "\n",
    );
  }
}
