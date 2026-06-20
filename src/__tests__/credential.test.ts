import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { FileCredentialStore } from "../credential/store.js";
import { activateWithCode, isValidActivationCode } from "../credential/activate.js";
import { isPro, isProWithStore, invalidateCredentialCache } from "../subscription/tier.js";

describe("CredentialStore", () => {
  let tmpFile: string;
  let store: FileCredentialStore;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `kevlar-cred-test-${Date.now()}`);
    store = new FileCredentialStore(tmpFile);
    process.env.KEVLAR_SKILLS_DIR = os.tmpdir();
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
    delete process.env.KEVLAR_TIER;
    delete process.env.KEVLAR_PRO_TOKEN;
    invalidateCredentialCache();
  });

  it("load returns null when no file exists", async () => {
    assert.equal(await store.load(), null);
  });

  it("round-trips save and load", async () => {
    const cred = {
      licenseKey: "test-key-123",
      refreshToken: "refresh-456",
      installationId: "install-789",
      activatedAt: new Date().toISOString(),
    };
    await store.save(cred);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded!.licenseKey, "test-key-123");
    assert.equal(loaded!.refreshToken, "refresh-456");
    assert.equal(loaded!.installationId, "install-789");
  });

  it("clear removes credential file", async () => {
    await store.save({ licenseKey: "k", installationId: "i", activatedAt: new Date().toISOString() });
    await store.clear();
    assert.equal(await store.load(), null);
  });

  it("loadSync returns null when no file exists", () => {
    assert.equal(store.loadSync(), null);
  });

  it("loadSync round-trips correctly", async () => {
    const cred = {
      licenseKey: "sync-key",
      refreshToken: "sync-refresh",
      installationId: "sync-install",
      activatedAt: new Date().toISOString(),
    };
    await store.save(cred);
    const loaded = store.loadSync();
    assert.ok(loaded);
    assert.equal(loaded!.licenseKey, "sync-key");
  });
});

describe("Activation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-activation-"));
    process.env.KEVLAR_SKILLS_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.KEVLAR_SKILLS_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("isValidActivationCode rejects invalid formats", () => {
    assert.equal(isValidActivationCode(""), false);
    assert.equal(isValidActivationCode("abc"), false);
    assert.equal(isValidActivationCode("ACT-XXXX-1234"), false);
    assert.equal(isValidActivationCode("KV-ACT-"), false);
  });

  it("isValidActivationCode accepts valid format", () => {
    assert.ok(isValidActivationCode("KV-ACT-8F3K-92QD-EXPIRES-10MIN"));
    assert.ok(isValidActivationCode("KV-ACT-ABCD-1234"));
  });

  it("activateWithCode returns error for invalid code", async () => {
    const store = new FileCredentialStore(path.join(os.tmpdir(), `kevlar-act-test-${Date.now()}`));
    const result = await activateWithCode("bad-code", store);
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });

  it("activateWithCode saves credential for valid code", async () => {
    const tmpFile = path.join(os.tmpdir(), `kevlar-act-test-${Date.now()}`);
    const store = new FileCredentialStore(tmpFile);
    const result = await activateWithCode("KV-ACT-8F3K-92QD-EXPIRES-10MIN", store);
    assert.ok(result.ok);
    assert.ok(result.credential);
    assert.ok(result.credential!.licenseKey);

    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded!.licenseKey, result.credential!.licenseKey);
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
  });
});

describe("isPro with credential store", () => {
  let tmpFile: string;
  let store: FileCredentialStore;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `kevlar-tier-test-${Date.now()}`);
    store = new FileCredentialStore(tmpFile);
    process.env.KEVLAR_SKILLS_DIR = os.tmpdir();
    invalidateCredentialCache();
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
    delete process.env.KEVLAR_TIER;
    delete process.env.KEVLAR_PRO_TOKEN;
    invalidateCredentialCache();
  });

  it("returns false when no credential file exists", () => {
    assert.equal(isPro(), false);
  });

  it("returns true when credential file exists", async () => {
    await store.save({ licenseKey: "pro-key", installationId: "i", activatedAt: new Date().toISOString() });
    assert.equal(isProWithStore(store), true);
  });

  it("env var KEVLAR_TIER overrides credential", async () => {
    process.env.KEVLAR_TIER = "pro";
    assert.equal(isPro(), true);
  });
});
