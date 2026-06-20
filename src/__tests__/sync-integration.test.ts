import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, createHmac } from "node:crypto";

import { syncStrategyBundle, getCachedBundle, clearBundleCache, getBundleCacheStatus, type SyncConfig } from "../pro/credential/syncClient.js";
import { ActivationClient } from "../pro/credential/activationClient.js";
import { verifyBundleIntegrity, makeDefaultProBundle, resolveTemplateVars, isBundleExpired, canonicalJSONDeep, type StrategyBundleV1 } from "../pro/strategyBundle.js";
import { saveBundleToCache } from "../pro/credential/bundleCache.js";

const HMAC_KEY = "kevlar-bundle-signing-dev";

function hmacSignBundle(bundle: StrategyBundleV1): StrategyBundleV1 {
  const { bundleSignature: _sig, ...data } = bundle;
  const canonical = canonicalJSONDeep(data as any);
  bundle.bundleSignature = createHmac("sha256", HMAC_KEY).update(canonical).digest("base64");
  return bundle;
}

function makeTestBundle(overrides?: Partial<StrategyBundleV1>): StrategyBundleV1 {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const graceExpiresAt = new Date(expiresAt.getTime() + 14 * 24 * 60 * 60 * 1000);
  const bundle: StrategyBundleV1 = {
    formatVersion: "kevlar-strategy-bundle-v1",
    bundleId: "bnd_v1_test_integration_1234",
    version: "1.0.0-test",
    tier: "pro",
    steps: ["local_rules", "orchestration_step0", "strip_context", "bare_audit", "full_audit", "delta_analysis", "merge_local_findings", "cross_validation", "synergy_weighting", "final_arbitration", "display"],
    visibility: { preAuditDetails: "full", rstContinuationPrompt: "after_pre_audit", upgradePrompt: "disabled" },
    templates: { finalizer: "测试 template {{watermark}}" },
    dimensionMultipliers: { legal_compliance: 1.0, social_risk: 1.0 },
    synergyRules: [],
    strategySessionId: "ses_test_1234",
    strategyHash: "sha256_test_hash_1234",
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    gracePeriodHours: 336,
    graceExpiresAt: graceExpiresAt.toISOString(),
    watermarkToken: "wm_test_1234",
    canaryToken: "cn_test_1234",
    sessionNonce: "nonce_test_1234",
    bundleSignature: "",
    ...overrides,
  };
  return hmacSignBundle(bundle);
}

interface MockServerState {
  sessionCount: number;
  currentBundleId: string;
  revokedHashes: string[];
  return304: boolean;
  validToken: string;
  validTokens?: Record<string, string>;
  sessions?: Record<string, { licenseKey: string; bundleId: string }>;
  bundles?: Record<string, { licenseKey: string }>;
}

function startMockServer(port: number, state: MockServerState) {
  state.sessions ??= {};
  state.bundles ??= {};

  const server = http.createServer(async (req, res) => {
    const tokenLicenses = state.validTokens ?? { [state.validToken]: "kv-lic-test-integration" };
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url!, `http://localhost:${port}`);

    if (req.method === "POST" && url.pathname === "/api/v1/activate") {
      const body = JSON.parse(await readBody(req));
      if (!body.activationCode || !body.installationId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: { code: "INVALID_REQUEST", message: "missing fields" } }));
        return;
      }
      if (!/^KV-ACT-[A-Z0-9-]+$/.test(body.activationCode)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: { code: "INVALID_CODE_FORMAT", message: "bad format" } }));
        return;
      }
      if (body.activationCode === "KV-ACT-USEDCODE-EXPIRES-10MIN") {
        res.writeHead(401);
        res.end(JSON.stringify({ error: { code: "CODE_ALREADY_USED", message: "already used" } }));
        return;
      }
      if (body.activationCode === "KV-ACT-EXPIRED-CODE-EXPIRES-10MIN") {
        res.writeHead(401);
        res.end(JSON.stringify({ error: { code: "CODE_EXPIRED", message: "expired" } }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({
        licenseKey: "kv-lic-test-integration",
        refreshToken: "rt_test_refresh_token_1234",
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/strategy/session") {
      const auth = req.headers.authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
      const licenseKey = tokenLicenses[token];
      if (!licenseKey) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: { code: "INVALID_TOKEN", message: "bad token" } }));
        return;
      }
      const body = JSON.parse(await readBody(req));
      if (!/^[\w.-]+$/.test(body.sessionId) || body.sessionId.length > 128) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: { code: "INVALID_SESSION_ID", message: "bad sessionId" } }));
        return;
      }
      if (!/^[\w.-]+$/.test(body.installationId) || body.installationId.length > 256) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: { code: "INVALID_INSTALLATION_ID", message: "bad installationId" } }));
        return;
      }

      if (state.return304) {
        res.writeHead(304);
        res.end();
        return;
      }

      state.sessionCount++;
      const sessionNonce = "nonce_" + state.sessionCount;
      state.sessions![sessionNonce] = { licenseKey, bundleId: state.currentBundleId };
      state.bundles![state.currentBundleId] = { licenseKey };
      res.writeHead(200);
      res.end(JSON.stringify({
        bundleId: state.currentBundleId,
        nonce: sessionNonce,
        sessionNonce,
        watermarkToken: "wm_test",
        canaryToken: "cn_test",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      }));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/v1/strategy/bundle/")) {
      const auth = req.headers.authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
      const licenseKey = tokenLicenses[token];
      if (!licenseKey) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: { code: "INVALID_TOKEN", message: "bad token" } }));
        return;
      }

      const nonce = req.headers["x-nonce"];
      if (!nonce) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: { code: "INVALID_NONCE", message: "no nonce" } }));
        return;
      }

      const session = state.sessions![String(nonce)];
      if (!session || session.licenseKey !== licenseKey) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: { code: "SESSION_NOT_OWNED", message: "session does not belong to license" } }));
        return;
      }

      const bundleId = url.pathname.split("/").pop()!;
      const bundleOwner = state.bundles![bundleId];
      if (!bundleOwner || bundleOwner.licenseKey !== licenseKey) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: { code: "BUNDLE_NOT_OWNED", message: "bundle does not belong to license" } }));
        return;
      }

      const bundle = makeTestBundle({ bundleId });
      res.writeHead(200);
      res.end(JSON.stringify(bundle));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/revocation/bundle-hashes") {
      res.writeHead(200);
      res.end(JSON.stringify({ revokedHashes: state.revokedHashes, updatedAt: new Date().toISOString() }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such endpoint" } }));
  });

  server.listen(port);
  return server;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => data += chunk.toString());
    req.on("end", () => resolve(data));
  });
}

let mockPort = 10876;
function nextPort(): number {
  return mockPort++;
}

describe("Bundle sync integration — HTTP mock server", () => {
  let server: http.Server;
  let port: number;
  let skillsDir: string;
  let state: MockServerState;

  beforeEach(() => {
    port = nextPort();
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-sync-int-"));
    state = { sessionCount: 0, currentBundleId: "bnd_v1_test_5678", revokedHashes: [], return304: false, validToken: "rt_test_token" };
    server = startMockServer(port, state);
  });

  afterEach(() => {
    server.close();
    clearBundleCache(skillsDir);
    try { fs.rmSync(skillsDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("complete sync flow: session → bundle → verify → cache", async () => {
    const config: SyncConfig = {
      refreshToken: state.validToken,
      installationId: "install_test_uuid",
      serverUrl: `http://localhost:${port}`,
      clientVersion: "1.0.0-test",
      locale: "zh-CN",
      skillsDir,
    };

    const result = await syncStrategyBundle(config);

    assert.equal(result.ok, true);
    assert.equal(result.status, "synced");
    assert.equal(result.bundleId, state.currentBundleId);
    assert.ok(result.bundle);

    const cached = getCachedBundle(skillsDir);
    assert.ok(cached);
    assert.equal(cached!.bundleId, state.currentBundleId);

    const status = getBundleCacheStatus(skillsDir);
    assert.equal(status.exists, true);
    assert.equal(status.valid, true);
    assert.equal(status.expired, false);
    assert.equal(status.withinGrace, false);
  });

  it("return 304 when bundle is already latest", async () => {
    state.return304 = true;

    const config: SyncConfig = {
      refreshToken: state.validToken,
      installationId: "install_test",
      serverUrl: `http://localhost:${port}`,
      skillsDir,
    };

    const result = await syncStrategyBundle(config);

    assert.equal(result.ok, true);
    assert.equal(result.status, "already_latest");
  });

  it("server unreachable returns error", async () => {
    const config: SyncConfig = {
      refreshToken: "rt_test",
      installationId: "install_test",
      serverUrl: `http://localhost:${port + 9999}`,
      skillsDir,
    };

    const result = await syncStrategyBundle(config);

    assert.equal(result.ok, false);
    assert.equal(result.status, "server_unreachable");
  });

  it("revoked bundle is rejected", async () => {
    state.revokedHashes = ["sha256_test_hash_1234"];

    const config: SyncConfig = {
      refreshToken: state.validToken,
      installationId: "install_test",
      serverUrl: `http://localhost:${port}`,
      skillsDir,
    };

    const result = await syncStrategyBundle(config);

    assert.equal(result.ok, false);
    assert.equal(result.status, "error");
    assert.ok(result.error!.includes("revoked"));
  });

  it("invalid token returns error", async () => {
    const config: SyncConfig = {
      refreshToken: "this_is_not_the_valid_token",
      installationId: "install_test",
      serverUrl: `http://localhost:${port}`,
      skillsDir,
    };

    const result = await syncStrategyBundle(config);

    assert.equal(result.ok, false);
    assert.equal(result.status, "server_unreachable");
  });

  it("round-trip bundle cache: sync then sync again with same hash", async () => {
    const config: SyncConfig = {
      refreshToken: state.validToken,
      installationId: "install_test",
      serverUrl: `http://localhost:${port}`,
      skillsDir,
    };

    const r1 = await syncStrategyBundle(config);
    assert.equal(r1.ok, true);

    state.return304 = true;
    const r2 = await syncStrategyBundle(config);
    assert.equal(r2.ok, true);
    assert.equal(r2.status, "already_latest");
  });

  it("rejects bundle download when session nonce is reused with another license", async () => {
    state.validTokens = {
      rt_license_A: "kv_lic_A",
      rt_license_B: "kv_lic_B",
    };

    const sessionRes = await fetch(`http://localhost:${port}/api/v1/strategy/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer rt_license_A" },
      body: JSON.stringify({ installationId: "install.A_1", sessionId: "session.A_1" }),
    });
    assert.equal(sessionRes.status, 200);
    const session = await sessionRes.json() as { bundleId: string; sessionNonce: string };

    const bundleRes = await fetch(`http://localhost:${port}/api/v1/strategy/bundle/${session.bundleId}`, {
      headers: { Authorization: "Bearer rt_license_B", "X-Nonce": session.sessionNonce },
    });
    const body = await bundleRes.json() as { error: { code: string } };

    assert.equal(bundleRes.status, 403);
    assert.equal(body.error.code, "SESSION_NOT_OWNED");
  });

  it("rejects bundle id owned by another license", async () => {
    state.validTokens = {
      rt_license_A: "kv_lic_A",
      rt_license_B: "kv_lic_B",
    };

    state.currentBundleId = "bundle.for.A";
    const sessionARes = await fetch(`http://localhost:${port}/api/v1/strategy/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer rt_license_A" },
      body: JSON.stringify({ installationId: "install.A_1", sessionId: "session.A_1" }),
    });
    const sessionA = await sessionARes.json() as { bundleId: string };

    state.currentBundleId = "bundle.for.B";
    const sessionBRes = await fetch(`http://localhost:${port}/api/v1/strategy/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer rt_license_B" },
      body: JSON.stringify({ installationId: "install.B_1", sessionId: "session.B_1" }),
    });
    const sessionB = await sessionBRes.json() as { sessionNonce: string };

    const bundleRes = await fetch(`http://localhost:${port}/api/v1/strategy/bundle/${sessionA.bundleId}`, {
      headers: { Authorization: "Bearer rt_license_B", "X-Nonce": sessionB.sessionNonce },
    });
    const body = await bundleRes.json() as { error: { code: string } };

    assert.equal(bundleRes.status, 403);
    assert.equal(body.error.code, "BUNDLE_NOT_OWNED");
  });
});

describe("ActivationClient — HTTP mock server", () => {
  let server: http.Server;
  let port: number;
  let skillsDir: string;

  beforeEach(() => {
    port = nextPort();
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-activation-int-"));
    server = startMockServer(port, { sessionCount: 0, currentBundleId: "bnd_v1_activation_test", revokedHashes: [], return304: false, validToken: "rt_test_refresh_token_1234" });
    process.env.KEVLAR_SERVER_URL = `http://localhost:${port}`;
    process.env.KEVLAR_SKILLS_DIR = skillsDir;
    ActivationClient.setFetch(async (url: string, init?: any) => {
      return fetch(url, init);
    });
  });

  afterEach(() => {
    server.close();
    ActivationClient.resetFetch();
    delete process.env.KEVLAR_SERVER_URL;
    delete process.env.KEVLAR_SKILLS_DIR;
    try { fs.rmSync(skillsDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("full activation flow: activate → session → bundle → verify", async () => {
    const client = new ActivationClient();
    const result = await client.tryFullActivation("KV-ACT-TESTCODE-EXPIRES-10MIN", "conv_test_123");

    assert.ok(result);
    assert.ok(result.credential);
    assert.equal(result.credential.licenseKey, "kv-lic-test-integration");
    assert.equal(result.credential.refreshToken, "rt_test_refresh_token_1234");
    assert.ok(result.bundle);
    assert.ok(verifyBundleIntegrity(result.bundle!));
  });

  it("invalid activation code returns null", async () => {
    const client = new ActivationClient();
    const result = await client.activate("not-a-valid-format", "install_uuid");
    assert.equal(result, null);
  });

  it("used activation code returns null", async () => {
    const client = new ActivationClient();
    const result = await client.activate("KV-ACT-USEDCODE-EXPIRES-10MIN", "install_uuid");
    assert.equal(result, null);
  });

  it("expired activation code returns null", async () => {
    const client = new ActivationClient();
    const result = await client.activate("KV-ACT-EXPIRED-CODE-EXPIRES-10MIN", "install_uuid");
    assert.equal(result, null);
  });
});

describe("Bundle signature verification — HMAC & Ed25519 both accepted", () => {
  it("HMAC-signed bundle verifies correctly", () => {
    const bundle = makeTestBundle();
    assert.equal(verifyBundleIntegrity(bundle), true);
  });

  it("tampered HMAC bundle fails verification", () => {
    const bundle = makeTestBundle();
    bundle.bundleId = "tampered-bundle-id";
    assert.equal(verifyBundleIntegrity(bundle), false);
  });

  it("default (offline) bundle uses self-hash", () => {
    const bundle = makeDefaultProBundle();
    assert.equal(verifyBundleIntegrity(bundle), true);
  });

  it("expired bundle (in grace period) reports correctly", () => {
    const bundle = makeTestBundle({
      expiresAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      graceExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const { expired, withinGrace } = isBundleExpired(bundle);
    assert.equal(expired, true);
    assert.equal(withinGrace, true);
  });

  it("fully expired bundle (beyond grace) reports correctly", () => {
    const bundle = makeTestBundle({
      expiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      graceExpiresAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const { expired, withinGrace } = isBundleExpired(bundle);
    assert.equal(expired, true);
    assert.equal(withinGrace, false);
  });
});

describe("resolveTemplateVars", () => {
  it("replaces placeholders", () => {
    const result = resolveTemplateVars("Hello {{name}}!", { name: "World" });
    assert.equal(result, "Hello World!");
  });

  it("handles watermark and canary tokens", () => {
    const result = resolveTemplateVars("{{watermark}} {{canary}}", { watermark: "wm_abc", canary: "cn_xyz" });
    assert.equal(result, "wm_abc cn_xyz");
  });

  it("returns original if no vars", () => {
    assert.equal(resolveTemplateVars("static text"), "static text");
  });
});

describe("BundleCacheStatus", () => {
  let skillsDir: string;

  beforeEach(() => {
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-cache-status-"));
  });

  afterEach(() => {
    clearBundleCache(skillsDir);
    try { fs.rmSync(skillsDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("returns not exists when no cache file", () => {
    const status = getBundleCacheStatus(skillsDir);
    assert.equal(status.exists, false);
    assert.equal(status.valid, false);
  });

  it("returns valid after save", () => {
    const bundle = makeTestBundle();
    saveBundleToCache(bundle, skillsDir);
    const status = getBundleCacheStatus(skillsDir);
    assert.equal(status.exists, true);
    assert.equal(status.valid, true);
    assert.equal(status.bundleId, bundle.bundleId);
    assert.equal(status.version, bundle.version);
  });

  it("clear removes cache file", () => {
    const bundle = makeTestBundle();
    saveBundleToCache(bundle, skillsDir);
    clearBundleCache(skillsDir);
    const status = getBundleCacheStatus(skillsDir);
    assert.equal(status.exists, false);
  });
});
