import { randomUUID } from "node:crypto";
import type { LicenseCredential, CredentialStore } from "./index.js";
import { ActivationClient } from "./activationClient.js";
import { saveBundleToCache } from "./bundleCache.js";
import { makeDefaultProBundle } from "../strategyBundle.js";
import { readConfig, writeConfig } from "../../execution/config.js";

const ACTIVATION_CODE_PATTERN = /^KV-ACT-[A-Z0-9-]+$/;

export function isValidActivationCode(code: string): boolean {
  return ACTIVATION_CODE_PATTERN.test(code);
}

export interface ActivationResult {
  ok: boolean;
  credential?: LicenseCredential;
  bundleId?: string;
  bundleVersion?: string;
  error?: string;
}

export async function activateWithCode(
  code: string,
  store: CredentialStore,
  sessionId?: string,
): Promise<ActivationResult> {
  if (!isValidActivationCode(code)) {
    return {
      ok: false,
      error: "激活码格式无效。格式应为：KV-ACT-XXXXXXXX-EXPIRES-10MIN",
    };
  }

  const installationId = randomUUID();

  // Try server activation
  const client = new ActivationClient();
  const activationResult = await client.activate(code, installationId);

  if (!activationResult) {
    // Server unreachable — generate local credential as fallback
    const credential: LicenseCredential = {
      licenseKey: `local-${randomUUID().slice(0, 8)}`,
      refreshToken: randomUUID(),
      installationId,
      activatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    };
    await store.save(credential);

    // Save a default Pro bundle for offline use
    const bundle = makeDefaultProBundle();
    saveBundleToCache(bundle);

    // Update config
    const config = readConfig();
    config.sync_token = credential.refreshToken;
    config.cloud_server_url = client["getServerUrl"]();
    writeConfig(config);

    return {
      ok: true,
      credential,
      bundleId: bundle.bundleId,
      bundleVersion: bundle.version,
    };
  }

  // Server activation succeeded
  const credential: LicenseCredential = {
    licenseKey: activationResult.licenseKey,
    refreshToken: activationResult.refreshToken,
    installationId,
    activatedAt: new Date().toISOString(),
    expiresAt: activationResult.expiresAt,
  };
  await store.save(credential);

  // Update config with server URL and sync token
  const config = readConfig();
  config.cloud_server_url = client["getServerUrl"]();
  config.sync_token = activationResult.refreshToken;
  writeConfig(config);

  // Try to download strategy bundle
  const sid = sessionId ?? `activation-${randomUUID().slice(0, 8)}`;
  const sessionResult = await client.createStrategySession(
    activationResult.refreshToken,
    installationId,
    sid,
  );

  if (sessionResult) {
    const bundle = await client.downloadBundle(
      activationResult.refreshToken,
      sessionResult.bundleId,
      sessionResult.nonce,
    );
    if (bundle) {
      saveBundleToCache(bundle);
      return {
        ok: true,
        credential,
        bundleId: bundle.bundleId,
        bundleVersion: bundle.version,
      };
    }
  }

  // Session creation or bundle download failed — use default bundle
  const defaultBundle = makeDefaultProBundle({
    strategySessionId: `offline-${randomUUID().slice(0, 8)}`,
    watermarkToken: randomUUID(),
    canaryToken: randomUUID(),
  });
  saveBundleToCache(defaultBundle);

  return {
    ok: true,
    credential,
    bundleId: defaultBundle.bundleId,
    bundleVersion: defaultBundle.version,
  };
}
