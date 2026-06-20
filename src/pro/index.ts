/**
 * @kevlar/pro-runtime — Public API
 *
 * This barrel exports everything the Free tier needs from the Pro runtime.
 * When extracted to a private npm package, this becomes the entry point.
 */

// Re-exports from Free tier (types + base functions used by Pro)
export { FreeStrategyProvider, InMemoryProStrategyProvider, type StrategyProvider, type Entitlement, type ReviewPlan, type SynergyWeights, type StrategyContext, computePlanFingerprint } from "../execution/strategy.js";

export { isPro, isProWithStore, isProAsync, invalidateCredentialCache } from "../subscription/tier.js";

export { type PromptSegments } from "../subscription/promptTypes.js";

export { loadPromptSegments, loadPromptSegmentsOrNull, writePromptSegmentsFile, type PromptTier } from "../subscription/promptTemplates.js";

// Pro credential management
export {
  type LicenseCredential,
  type CredentialStore,
  CREDENTIAL_FILENAME,
  obfuscate,
  deobfuscate,
} from "./credential/index.js";

export {
  FileCredentialStore,
} from "./credential/store.js";

// Pro sync & bundle cache
export {
  syncStrategyBundle,
  getCachedBundle,
  clearBundleCache,
  getBundleCacheStatus,
  type SyncConfig,
  type SyncResult,
  type BundleCacheStatus,
} from "./credential/syncClient.js";

export {
  ActivationClient,
  type ActivationResult,
  type StrategySessionResult,
  type ActivationFetchFn,
} from "./credential/activationClient.js";

export {
  activateWithCode,
  isValidActivationCode,
  type ActivationResult as ActivateResult,
} from "./credential/activate.js";

// Pro bundle format & verification
export {
  type StrategyBundleV1,
  verifyBundleIntegrity,
  signBundle,
  isBundleExpired,
  computeBundleHash,
  canonicalJSONDeep,
  canonicalJSON,
} from "./strategyBundle.js";

export {
  BundleStrategyProvider,
  verifyAndCreateProvider,
} from "./bundleStrategyProvider.js";

// Pro CLI (for scripts/cli.ts dynamic import)
export {
  runActivate,
  runStatus,
  runLogout,
  runDoctor,
  runSync,
} from "./credentialCli.js";

import { InMemoryProStrategyProvider } from "../execution/strategy.js";
import { isPro } from "../subscription/tier.js";
import { loadBundleFromCache } from "./credential/bundleCache.js";
import { verifyAndCreateProvider } from "./bundleStrategyProvider.js";
import { logger } from "../utils/logger.js";
import type { StrategyProvider } from "../execution/strategy.js";

/**
 * Main entry point for @kevlar/pro-runtime.
 * Called by DynamicImportProRuntimeLoader.tryLoad().
 *
 * Returns a StrategyProvider that uses server-synced strategy bundle
 * when available, or falls back to InMemoryProStrategyProvider.
 */
export async function createProStrategyProvider(skillsDir?: string): Promise<StrategyProvider> {
  if (isPro()) {
    try {
      const bundle = loadBundleFromCache(skillsDir);
      if (bundle) {
        const vars: Record<string, string> = {
          watermark: bundle.watermarkToken,
          canary: bundle.canaryToken,
          sessionId: bundle.strategySessionId,
          sessionNonce: bundle.sessionNonce,
          bundleId: bundle.bundleId,
        };
        const result = verifyAndCreateProvider(bundle, vars);
        if (result.ok) {
          logger.info("Pro runtime: loaded from cached bundle", {
            event: "pro_runtime_bundle_loaded",
            bundleId: bundle.bundleId,
            version: bundle.version,
          });
          return result.provider;
        }
        logger.warn("Pro runtime: cached bundle invalid", {
          event: "pro_runtime_bundle_invalid",
          reason: result.reason,
        });
      }
    } catch {
      logger.info("Pro runtime: no cached bundle", {
        event: "pro_runtime_no_bundle",
      });
    }
  }

  // Fallback to in-memory Pro provider (uses bundled defaults)
  logger.info("Pro runtime: using in-memory provider", {
    event: "pro_runtime_memory_provider",
  });
  return new InMemoryProStrategyProvider();
}
