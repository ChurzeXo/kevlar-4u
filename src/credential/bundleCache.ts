import * as path from "path";
import * as fs from "fs";
import type { StrategyBundleV1 } from "../execution/strategyBundle.js";
import { isBundleExpired } from "../execution/strategyBundle.js";
import { obfuscate, deobfuscate } from "./index.js";
import { logger } from "../utils/observability.js";

const BUNDLE_CACHE_FILENAME = "strategy-bundle-cache.enc";

function resolveSkillsDir(): string {
  if (process.env.KEVLAR_SKILLS_DIR) {
    return path.resolve(process.env.KEVLAR_SKILLS_DIR);
  }
  return path.resolve(process.cwd(), "skills");
}

export function getBundleCachePath(skillsDir?: string): string {
  const dir = skillsDir ?? resolveSkillsDir();
  return path.join(dir, BUNDLE_CACHE_FILENAME);
}

export function saveBundleToCache(bundle: StrategyBundleV1, skillsDir?: string): void {
  const filePath = getBundleCachePath(skillsDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const obfuscated = obfuscate(JSON.stringify(bundle));
  fs.writeFileSync(filePath, obfuscated, "utf-8");
}

export function loadBundleFromCache(skillsDir?: string): StrategyBundleV1 | null {
  const filePath = getBundleCachePath(skillsDir);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const decoded = deobfuscate(raw);
    if (!decoded) return null;
    const bundle = JSON.parse(decoded) as StrategyBundleV1;
    return bundle;
  } catch {
    return null;
  }
}

export function clearBundleCache(skillsDir?: string): void {
  const filePath = getBundleCachePath(skillsDir);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

export interface BundleCacheStatus {
  exists: boolean;
  valid: boolean;
  expired: boolean;
  withinGrace: boolean;
  bundleId?: string;
  version?: string;
  strategyHash?: string;
  expiresAt?: string;
  graceExpiresAt?: string;
}

export function getBundleCacheStatus(skillsDir?: string): BundleCacheStatus {
  const bundle = loadBundleFromCache(skillsDir);
  if (!bundle) {
    return { exists: false, valid: false, expired: false, withinGrace: false };
  }
  const { expired, withinGrace } = isBundleExpired(bundle);
  return {
    exists: true,
    valid: true,
    expired,
    withinGrace,
    bundleId: bundle.bundleId,
    version: bundle.version,
    strategyHash: bundle.strategyHash,
    expiresAt: bundle.expiresAt,
    graceExpiresAt: bundle.graceExpiresAt,
  };
}
