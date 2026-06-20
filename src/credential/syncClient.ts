import { randomUUID } from "node:crypto";
import {
  loadBundleFromCache,
  saveBundleToCache,
  getBundleCacheStatus,
  clearBundleCache,
  type BundleCacheStatus,
} from "./bundleCache.js";
import { deobfuscate } from "./index.js";
import type { StrategyBundleV1 } from "../execution/strategyBundle.js";
import { verifyBundleIntegrity } from "../execution/strategyBundle.js";
import { logger } from "../utils/observability.js";

export interface SyncConfig {
  refreshToken: string;
  installationId: string;
  serverUrl: string;
  clientVersion?: string;
  locale?: string;
  skillsDir?: string;
}

export interface SyncResult {
  ok: boolean;
  status: "synced" | "already_latest" | "server_unreachable" | "invalid_signature" | "error";
  bundleId?: string;
  bundle?: StrategyBundleV1;
  statusBefore?: BundleCacheStatus;
  statusAfter?: BundleCacheStatus;
  error?: string;
}

const REVOCATION_ENDPOINT = "/api/v1/revocation/bundle-hashes";

async function fetchRevocationList(serverUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${serverUrl}${REVOCATION_ENDPOINT}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { revokedHashes: string[] };
    return data.revokedHashes ?? [];
  } catch {
    return [];
  }
}

function isRevoked(bundle: StrategyBundleV1, revokedHashes: string[]): boolean {
  return revokedHashes.includes(bundle.strategyHash) || revokedHashes.includes(bundle.bundleId);
}

export async function syncStrategyBundle(config: SyncConfig): Promise<SyncResult> {
  const statusBefore = getBundleCacheStatus(config.skillsDir);

  try {
    const baseUrl = config.serverUrl.replace(/\/+$/, "");

    const sessionRes = await fetch(`${baseUrl}/api/v1/strategy/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.refreshToken}`,
      },
      body: JSON.stringify({
        installationId: config.installationId,
        sessionId: `sync-${randomUUID().slice(0, 8)}`,
        clientVersion: config.clientVersion ?? "1.0.0",
        locale: config.locale ?? "zh-CN",
        currentStrategyHash: statusBefore.bundleId
          ? statusBefore.strategyHash
          : undefined,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (sessionRes.status === 304) {
      return {
        ok: true,
        status: "already_latest",
        statusBefore,
        statusAfter: statusBefore,
      };
    }

    if (!sessionRes.ok) {
      return {
        ok: false,
        status: "server_unreachable",
        statusBefore,
        error: `Session creation failed: ${sessionRes.status}`,
      };
    }

    const session = await sessionRes.json() as {
      bundleId: string;
      sessionNonce: string;
    };

    const bundleRes = await fetch(
      `${baseUrl}/api/v1/strategy/bundle/${session.bundleId}`,
      {
        headers: {
          Authorization: `Bearer ${config.refreshToken}`,
          "X-Nonce": session.sessionNonce,
        },
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!bundleRes.ok) {
      return {
        ok: false,
        status: "server_unreachable",
        statusBefore,
        error: `Bundle download failed: ${bundleRes.status}`,
      };
    }

    const bundle = await bundleRes.json() as StrategyBundleV1;

    if (!verifyBundleIntegrity(bundle)) {
      logger.warn("Bundle failed Ed25519 signature verification", {
        event: "bundle_signature_mismatch",
        bundleId: session.bundleId,
      });
      return {
        ok: false,
        status: "invalid_signature",
        statusBefore,
        error: "Ed25519 signature verification failed",
      };
    }

    const revoked = await fetchRevocationList(baseUrl);
    if (isRevoked(bundle, revoked)) {
      logger.warn("Bundle is revoked", {
        event: "bundle_revoked",
        bundleId: session.bundleId,
      });
      return {
        ok: false,
        status: "error",
        statusBefore,
        error: "Bundle is revoked",
      };
    }

    saveBundleToCache(bundle, config.skillsDir);
    const statusAfter = getBundleCacheStatus(config.skillsDir);

    return {
      ok: true,
      status: "synced",
      bundleId: session.bundleId,
      bundle,
      statusBefore,
      statusAfter,
    };
  } catch (err) {
    return {
      ok: false,
      status: "server_unreachable",
      statusBefore,
      error: (err as Error).message,
    };
  }
}

export function getCachedBundle(skillsDir?: string): StrategyBundleV1 | null {
  return loadBundleFromCache(skillsDir);
}

export { clearBundleCache, getBundleCacheStatus };
export type { BundleCacheStatus };
