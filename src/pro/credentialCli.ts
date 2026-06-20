import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as fsp from "fs/promises";
import { randomUUID } from "node:crypto";

import { obfuscate, deobfuscate, CREDENTIAL_FILENAME } from "./credential/index.js";
import { verifyBundleIntegrity } from "./strategyBundle.js";

// ── File paths ──────────────────────────────────────────────────

const SKILLS_DIR = process.env.KEVLAR_SKILLS_DIR || path.join(process.cwd(), "skills");

function configPath(): string {
  return path.join(SKILLS_DIR, "kevlar-config.json");
}

const CREDENTIAL_PATH = path.join(os.homedir(), CREDENTIAL_FILENAME);

// ── Ed25519 bundle signature verification ───────────────────────

function verifyBundleSignature(bundle: any): boolean {
  return verifyBundleIntegrity(bundle);
}

// ── Credential I/O ─────────────────────────────────────────────

function loadCredentials(): { licenseKey: string; refreshToken?: string; installationId?: string; activatedAt: string; expiresAt?: string } | null {
  try {
    const content = fs.readFileSync(CREDENTIAL_PATH, "utf-8");
    const json = deobfuscate(content.trim());
    if (!json) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function saveCredentials(cred: { licenseKey: string; refreshToken?: string; installationId: string; activatedAt: string; expiresAt?: string }): Promise<void> {
  const json = JSON.stringify(cred, null, 2);
  const encoded = obfuscate(json);
  await fsp.writeFile(CREDENTIAL_PATH, encoded, { mode: 0o600 });
}

async function clearCredentials(): Promise<void> {
  try {
    await fsp.unlink(CREDENTIAL_PATH);
  } catch {
    // non-fatal
  }
}

// ── Activation ─────────────────────────────────────────────────

const ACTIVATION_CODE_RE = /^KV-ACT-[A-Z0-9-]+$/;

function isValidActivationCode(code: string): boolean {
  return ACTIVATION_CODE_RE.test(code);
}

// ── Commands ───────────────────────────────────────────────────

function getServerUrl(): string {
  if (process.env.KEVLAR_SERVER_URL) return process.env.KEVLAR_SERVER_URL.replace(/\/+$/, "");
  try {
    const config = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
    if (config.cloud_server_url) return config.cloud_server_url.replace(/\/+$/, "");
  } catch { /* no config */ }
  return "https://kevlar4u.xyz";
}

const BUNDLE_CACHE_PATH = path.join(SKILLS_DIR, "strategy-bundle-cache.enc");

async function tryDownloadBundle(token: string, installationId: string): Promise<string | null> {
  const baseUrl = getServerUrl();
  try {
    const sessionRes = await fetch(`${baseUrl}/api/v1/strategy/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ installationId, sessionId: `cli-activate-${randomUUID().slice(0, 8)}` }),
      signal: AbortSignal.timeout(10000),
    });
    if (!sessionRes.ok) return null;
    const session: any = await sessionRes.json();

    const bundleRes = await fetch(`${baseUrl}/api/v1/strategy/bundle/${session.bundleId}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Nonce": session.sessionNonce ?? session.nonce },
      signal: AbortSignal.timeout(15000),
    });
    if (!bundleRes.ok) return null;
    const bundle: any = await bundleRes.json();

    if (!verifyBundleSignature(bundle)) {
      console.warn("⚠ 下载的策略包签名验证失败");
      return null;
    }

    const raw = JSON.stringify(bundle);
    await fsp.mkdir(path.dirname(BUNDLE_CACHE_PATH), { recursive: true });
    await fsp.writeFile(BUNDLE_CACHE_PATH, obfuscate(raw), "utf-8");
    return bundle.bundleId || "downloaded";
  } catch {
    return null;
  }
}

// ── Sync command ─────────────────────────────────────────────────

export async function runSync(): Promise<void> {
  const cred = loadCredentials();
  if (!cred?.refreshToken) {
    console.log("❌ 无有效的凭证。请先运行 kevlar-4u --activate --code <激活码>");
    return;
  }

  let config: any = {};
  try { config = JSON.parse(fs.readFileSync(configPath(), "utf-8")); } catch { /* ok */ }

  const serverUrl = config.cloud_server_url || process.env.KEVLAR_SERVER_URL || "https://kevlar4u.xyz";
  const installationId = cred.installationId || randomUUID();
  const refreshToken = cred.refreshToken;

  console.log("🌐 正在连接策略服务器...");

  const sessionId = `cli-sync-${randomUUID().slice(0, 8)}`;
  try {
    const sessionRes = await fetch(`${serverUrl}/api/v1/strategy/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${refreshToken}` },
      body: JSON.stringify({
        installationId,
        sessionId,
        clientVersion: process.env.npm_package_version || "1.0.0",
        locale: "zh-CN",
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (sessionRes.status === 304) {
      console.log("✅ 策略包已是最新，无需同步。");
      return;
    }

    if (!sessionRes.ok) {
      console.log(`❌ 会话创建失败: ${sessionRes.status}`);
      return;
    }

    const session: any = await sessionRes.json();
    console.log(`📦 正在下载策略包 ${session.bundleId}...`);

    const bundleRes = await fetch(`${serverUrl}/api/v1/strategy/bundle/${session.bundleId}`, {
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        "X-Nonce": session.sessionNonce ?? session.nonce,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!bundleRes.ok) {
      console.log(`❌ 策略包下载失败: ${bundleRes.status}`);
      return;
    }

    const bundle: any = await bundleRes.json();

    if (!verifyBundleSignature(bundle)) {
      console.log("❌ 策略包 Ed25519 签名验证失败");
      return;
    }

    // Check revocation list
    try {
      const revRes = await fetch(`${serverUrl}/api/v1/revocation/bundle-hashes`, {
        signal: AbortSignal.timeout(8000),
      });
      if (revRes.ok) {
        const revData: any = await revRes.json();
        if (revData.revokedHashes?.includes(bundle.strategyHash) || revData.revokedHashes?.includes(bundle.bundleId)) {
          console.log("❌ 策略包已被吊销");
          return;
        }
      }
    } catch { /* revocation check best-effort */ }

    const raw = JSON.stringify(bundle);
    await fsp.mkdir(path.dirname(BUNDLE_CACHE_PATH), { recursive: true });
    await fsp.writeFile(BUNDLE_CACHE_PATH, obfuscate(raw), "utf-8");

    console.log(`✅ 策略包同步完成: ${session.bundleId}`);
    console.log(`   版本: ${bundle.version || "?"}`);
    console.log(`   过期: ${bundle.expiresAt || "无"}`);
    if (bundle.graceExpiresAt) console.log(`   宽限期: ${bundle.graceExpiresAt}`);
  } catch (err) {
    console.log(`❌ 同步失败: ${(err as Error).message}`);
  }
}

export async function runActivate(code?: string): Promise<void> {
  if (!code) {
    console.log("❌ 请提供激活码：kevlar-4u --activate --code <激活码>");
    return;
  }

  if (!isValidActivationCode(code)) {
    console.log("❌ 激活码格式无效。格式应为：KV-ACT-XXXXXXXX-EXPIRES-10MIN");
    return;
  }

  const installationId = randomUUID();
  const baseUrl = getServerUrl();
  let credential: any;
  let bundleId: string | null = null;

  // Try server activation
  try {
    const res = await fetch(`${baseUrl}/api/v1/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activationCode: code, installationId }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data: any = await res.json();
      credential = {
        licenseKey: data.licenseKey,
        refreshToken: data.refreshToken,
        installationId,
        activatedAt: new Date().toISOString(),
        expiresAt: data.expiresAt,
      };
      // Try to download strategy bundle
      bundleId = await tryDownloadBundle(data.refreshToken, installationId);
    } else {
      const errData: any = await res.json().catch(() => null);
      if (errData?.error?.code === "ACTIVATION_FAILED") {
        console.log(`❌ 激活失败：${errData.error.message}`);
        return;
      }
    }
  } catch {
    // Server unreachable
  }

  // Fallback: local activation if server unreachable
  if (!credential) {
    console.log("⚠ Kevlar 激活服务器不可用，使用本地激活模式");
    credential = {
      licenseKey: `local-${randomUUID().slice(0, 8)}`,
      refreshToken: randomUUID(),
      installationId,
      activatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  await saveCredentials(credential);

  // Update config
  const config: any = { updatedAt: new Date().toISOString() };
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(configPath(), "utf-8")));
  } catch { /* no config */ }
  config.sync_token = credential.refreshToken;
  config.cloud_server_url = baseUrl;
  await fsp.writeFile(configPath(), JSON.stringify(config, null, 2));

  console.log("✅ Pro 版已激活！");
  console.log(`   激活时间：${credential.activatedAt}`);
  if (credential.expiresAt) console.log(`   过期时间：${credential.expiresAt}`);
  if (bundleId) console.log(`   策略包：${bundleId}`);
  console.log("   许可证信息已安全保存，未回显到会话。");
}

export function runStatus(): void {
  const cred = loadCredentials();
  const envTier = process.env.KEVLAR_TIER;
  const envProToken = process.env.KEVLAR_PRO_TOKEN;

  let tier = "free";
  if (envTier === "pro") tier = "pro (环境变量)";
  else if (envProToken) tier = "pro (KEVLAR_PRO_TOKEN)";
  else if (cred) tier = "pro (已激活)";
  else {
    try {
      const config = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
      if (config.sync_token) tier = `pro (config.sync_token)`;
    } catch { /* no config */ }
  }

  console.log(`Kevlar-4u 版本：${process.env.npm_package_version || "1.0.0"}`);
  console.log(`当前状态：${tier.startsWith("pro") ? "✅ Pro" : "🆓 Free"}`);
  console.log(`策略路径：${SKILLS_DIR}`);
  console.log(`凭证文件：${CREDENTIAL_PATH}${cred ? " (存在)" : " (不存在)"}`);
  if (cred?.expiresAt) {
    const remaining = Math.round((new Date(cred.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    console.log(`凭证过期：${cred.expiresAt}（剩余 ${remaining} 天）`);
  }
}

export async function runLogout(): Promise<void> {
  await clearCredentials();
  // Also clear sync_token from config + strategy bundle cache
  try {
    const config = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
    delete config.sync_token;
    config.updatedAt = new Date().toISOString();
    await fsp.writeFile(configPath(), JSON.stringify(config, null, 2));
  } catch {
    // non-fatal
  }
  try { await fsp.unlink(BUNDLE_CACHE_PATH); } catch { /* non-fatal */ }
  console.log("✅ 凭证已清除，已降级为 Free 版。");
}

export async function runDoctor(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // Node version
  const nodeMajor = parseInt(process.version.slice(1).split(".")[0], 10);
  checks.push({
    name: "Node.js 版本",
    ok: nodeMajor >= 18,
    detail: `${process.version} ${nodeMajor >= 18 ? "✓" : "⚠ 需要 >= 18"}`,
  });

  // Skills dir
  const skillsExists = fs.existsSync(SKILLS_DIR);
  checks.push({
    name: "策略目录",
    ok: skillsExists,
    detail: skillsExists ? `${SKILLS_DIR} ✓` : `${SKILLS_DIR} ⚠ 不存在`,
  });

  // Config file
  const configExists = fs.existsSync(configPath());
  checks.push({
    name: "配置文件",
    ok: true,
    detail: configExists ? `${configPath()} ✓` : `${configPath()} (不存在，将使用默认值)`,
  });

  // Credential store
  const cred = loadCredentials();
  checks.push({
    name: "凭证文件",
    ok: true,
    detail: cred
      ? `${CREDENTIAL_PATH} ✓ (已激活，过期: ${cred.expiresAt || "无"})`
      : `${CREDENTIAL_PATH} (无凭证)`,
  });

  // Pro status
  const pro = !!(cred || process.env.KEVLAR_TIER === "pro" || process.env.KEVLAR_PRO_TOKEN);
  checks.push({
    name: "Pro 状态",
    ok: true,
    detail: pro ? "✅ 已启用" : "🆓 Free",
  });

  // Strategy bundle cache
  const bundleExists = fs.existsSync(BUNDLE_CACHE_PATH);
  if (bundleExists) {
    try {
      const raw = fs.readFileSync(BUNDLE_CACHE_PATH, "utf-8").trim();
      const decoded = deobfuscate(raw);
      if (decoded) {
        const bundle = JSON.parse(decoded);
        checks.push({
          name: "策略包缓存",
          ok: true,
          detail: `${bundle.bundleId || "unknown"} v${bundle.version || "?"} (过期: ${bundle.expiresAt || "无"})`,
        });
      } else {
        checks.push({
          name: "策略包缓存",
          ok: false,
          detail: `${BUNDLE_CACHE_PATH} (解密失败)`,
        });
      }
    } catch {
      checks.push({
        name: "策略包缓存",
        ok: false,
        detail: `${BUNDLE_CACHE_PATH} (解析失败)`,
      });
    }
  } else {
    checks.push({
      name: "策略包缓存",
      ok: true,
      detail: "无缓存",
    });
  }

  // Config validity
  try {
    if (configExists) {
      const config = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
      checks.push({
        name: "配置完整性",
        ok: true,
        detail: `mode: ${config.mode || "auto"}, concurrency: ${config.multiAgent?.maxConcurrency || 3}`,
      });
    }
  } catch {
    checks.push({
      name: "配置完整性",
      ok: false,
      detail: "配置 JSON 解析失败",
    });
  }

  // Print results
  console.log(`\n  Kevlar-4u 诊断报告\n`);
  for (const check of checks) {
    console.log(`  ${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  }
  console.log();
}
