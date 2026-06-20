import { randomUUID } from "node:crypto";
import type { StrategyBundleV1 } from "../strategyBundle.js";
import { readConfig, writeConfig } from "../../execution/config.js";
import { logger } from "../../utils/observability.js";

export interface ActivationResult {
  licenseKey: string;
  refreshToken: string;
  installationId: string;
  expiresAt: string;
}

export interface StrategySessionResult {
  strategySessionId: string;
  bundleId: string;
  nonce: string;
  expiresAt: string;
  watermarkToken: string;
  canaryToken: string;
}

export type ActivationFetchFn = (url: string, init?: any) => Promise<any>;

export class ActivationClient {
  private static fetchFn: ActivationFetchFn = globalThis.fetch.bind(globalThis);

  static setFetch(fn: ActivationFetchFn): void {
    ActivationClient.fetchFn = fn;
  }

  static resetFetch(): void {
    ActivationClient.fetchFn = globalThis.fetch.bind(globalThis);
  }

  private getServerUrl(): string {
    const config = readConfig();
    if (config.cloud_server_url) {
      return config.cloud_server_url.replace(/\/+$/, "");
    }
    if (process.env.KEVLAR_SERVER_URL) {
      return process.env.KEVLAR_SERVER_URL.replace(/\/+$/, "");
    }
    return "https://kevlar4u.xyz";
  }

  async activate(code: string, installationId: string): Promise<ActivationResult | null> {
    const baseUrl = this.getServerUrl();
    try {
      const res = await ActivationClient.fetchFn(`${baseUrl}/api/v1/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activationCode: code, installationId }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        if (errorData?.error?.code === "ACTIVATION_FAILED") {
          throw new Error(`ACTIVATION_FAILED: ${errorData.error.message}`);
        }
        logger.warn("Activation server returned error", {
          event: "activation_server_error",
          status: res.status,
        });
        return null;
      }
      const data: ActivationResult = await res.json();
      data.installationId = installationId;
      return data;
    } catch (err: any) {
      logger.warn("Activation server unreachable", {
        event: "activation_server_unreachable",
        server: baseUrl,
        error: err?.message,
      });
      return null;
    }
  }

  async createStrategySession(
    token: string,
    installationId: string,
    sessionId: string,
  ): Promise<StrategySessionResult | null> {
    const baseUrl = this.getServerUrl();
    try {
      const res = await ActivationClient.fetchFn(`${baseUrl}/api/v1/strategy/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ installationId, sessionId }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      return res.json() as Promise<StrategySessionResult>;
    } catch {
      return null;
    }
  }

  async downloadBundle(
    token: string,
    bundleId: string,
    nonce: string,
  ): Promise<StrategyBundleV1 | null> {
    const baseUrl = this.getServerUrl();
    try {
      const res = await ActivationClient.fetchFn(
        `${baseUrl}/api/v1/strategy/bundle/${bundleId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Nonce": nonce,
          },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!res.ok) return null;
      return res.json() as Promise<StrategyBundleV1>;
    } catch {
      return null;
    }
  }

  async tryFullActivation(
    code: string,
    sessionId: string,
    existingInstallationId?: string,
  ): Promise<{
    credential: ActivationResult;
    bundle: StrategyBundleV1 | null;
  } | null> {
    const installationId = existingInstallationId ?? randomUUID();

    const activationResult = await this.activate(code, installationId);
    if (!activationResult) return null;

    const config = readConfig();
    config.cloud_server_url = this.getServerUrl();
    config.sync_token = activationResult.refreshToken;
    writeConfig(config);

    const sessionResult = await this.createStrategySession(
      activationResult.refreshToken,
      installationId,
      sessionId,
    );
    if (!sessionResult) {
      return { credential: activationResult, bundle: null };
    }

    const bundle = await this.downloadBundle(
      activationResult.refreshToken,
      sessionResult.bundleId,
      sessionResult.nonce,
    );

    if (bundle) {
      const { verifyBundleIntegrity } = await import("../strategyBundle.js");
      if (!verifyBundleIntegrity(bundle)) {
        logger.warn("Downloaded bundle has invalid signature", {
          event: "bundle_signature_mismatch",
          bundleId: sessionResult.bundleId,
        });
        return { credential: activationResult, bundle: null };
      }
    }

    return { credential: activationResult, bundle };
  }
}
