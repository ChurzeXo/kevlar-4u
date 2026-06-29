import { FreeStrategyProvider, InMemoryProStrategyProvider } from "./strategy.js";
import type { StrategyProvider } from "./strategy.js";
import { isPro } from "../subscription/tier.js";
import { logger } from "../utils/logger.js";

export interface ProRuntimeLoader {
  tryLoad(): Promise<StrategyProvider | null>;
}

// ── Dynamic import loader — tries @kevlar/pro-runtime ────────────

export class DynamicImportProRuntimeLoader implements ProRuntimeLoader {
  private tried = false;
  private cached: StrategyProvider | null = null;

  async tryLoad(): Promise<StrategyProvider | null> {
    if (this.tried) return this.cached;
    this.tried = true;

    // Allow disabling via env for testing
    if (process.env.KEVLAR_SKIP_PRO_IMPORT === "1") {
      // logger.info("Pro runtime disabled via KEVLAR_SKIP_PRO_IMPORT", {
      //   event: "pro_runtime_skipped",
      // });
      return null;
    }

    try {
      const mod = await import("@kevlar/pro-runtime");
      if (typeof mod.createProStrategyProvider === "function") {
        const provider = await mod.createProStrategyProvider();
        this.cached = provider;
        // logger.info("Pro runtime loaded", { event: "pro_runtime_loaded" });
        return provider;
      }
      // logger.warn("Pro runtime found but no createProStrategyProvider export", {
      //   event: "pro_runtime_invalid",
      // });
      return null;
    } catch (err) {
      // logger.info("Pro runtime not available, using Free", {
      //   event: "pro_runtime_unavailable",
      //   reason: (err as Error)?.message ?? String(err),
      // });
      return null;
    }
  }

  reset(): void {
    this.tried = false;
    this.cached = null;
  }
}

// ── Null/mock loader for testing ─────────────────────────────────

/** Always returns null — Pro runtime not available. */
export class NullProRuntimeLoader implements ProRuntimeLoader {
  async tryLoad(): Promise<StrategyProvider | null> {
    return null;
  }
}

/** Always returns an InMemoryProStrategyProvider for testing. */
export class MockProRuntimeLoader implements ProRuntimeLoader {
  async tryLoad(): Promise<StrategyProvider | null> {
    return new InMemoryProStrategyProvider();
  }
}

// ── Resolver: try Pro → try cached bundle → fallback Free ────────

export async function resolveStrategyProvider(
  loader: ProRuntimeLoader,
  skillsDir?: string,
): Promise<StrategyProvider> {
  // 1. Try dynamic import of @kevlar/pro-runtime
  const pro = await loader.tryLoad();
  if (pro) return pro;

  // 2. Try cached strategy bundle via @kevlar/pro-runtime
  if (isPro()) {
    try {
      // Dynamic import — runtime resolution, cast to any for TS
      const pro = (await import("@kevlar/pro-runtime")) as any;
      const bundle = pro.getCachedBundle(skillsDir);
      if (bundle) {
        const vars: Record<string, string> = {
          watermark: bundle.watermarkToken,
          canary: bundle.canaryToken,
          sessionId: bundle.strategySessionId,
          sessionNonce: bundle.sessionNonce,
          bundleId: bundle.bundleId,
        };
        const result = pro.verifyAndCreateProvider(bundle, vars);
        if (result.ok) {
          // logger.info("Loaded Pro strategy from cached bundle", {
          //   event: "bundle_cache_loaded",
          //   bundleId: bundle.bundleId,
          //   version: bundle.version,
          // });
          return result.provider;
        }
        // logger.warn("Cached strategy bundle invalid, falling back to Free", {
        //   event: "bundle_cache_invalid",
        //   reason: result.reason,
        // });
      }
    } catch {
      // logger.info("No cached strategy bundle, using Free", {
      //   event: "bundle_cache_missing",
      // });
    }
  }

  // 3. Fallback to Free
  // logger.warn("Falling back to Free tier", {
  //   event: "fallback_to_free",
  // });
  return new FreeStrategyProvider();
}
