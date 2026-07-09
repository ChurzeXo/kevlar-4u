/**
 * Prompt Alias Resolver
 *
 * Evidence Aliases — i18n + IP Protection layer.
 *
 * Architecture:
 *   PromptSegments store alias references like "[PROTO:CORE_FRAMEWORK]"
 *   instead of raw text. The resolver maps alias → locale-specific text
 *   at prompt construction time.
 *
 * Plan A (80% generic instructions): resolvers expand aliases before
 * sending to LLM — LLM receives full localized text.
 *
 * Plan B (20% core IP — Pro only): aliases pass through to LLM
 * as-is. The LLM operates on symbolic handles. Client resolves output.
 *
 * This module currently implements Plan A universally. Plan B is
 * reserved for Pro tier via `isPlanBAlias()` gating.
 */

import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { getCurrentLanguage, type SupportedLanguage } from "../i18n/index.js";
import { logger } from "../utils/observability.js";
import { verifyAliasMapIntegrity as hashGuardVerifyAliasMap } from "./promptHashGuard.js";

// ── Types ────────────────────────────────────────────────────────────

export interface PromptAliasMap {
  /** Locale tag (zh-CN, en-US, ja-JP…) */
  locale: SupportedLanguage | string;
  /** Who tuned this mapping */
  tunedBy: string;
  /** ISO timestamp of last tuning pass */
  tunedAt: string;
  /** Alias ID → locale-specific full text */
  mappings: Record<string, string>;
  /** SHA-256 of the sorted JSON string of `mappings` (for integrity) */
  hash: string;
  /** Semantic version of this map (bump on tuning changes) */
  version: string;
}

/** Prefix that marks a segment value as an alias reference. */
const ALIAS_PREFIX = "[PROTO:";

/** Known Plan B aliases — these are sent to LLM as-is, not expanded. */
const PLAN_B_ALIASES = new Set<string>([
  // Reserved for Pro tier — no entries in Free yet.
  // When Pro core IP is aliased, add IDs here.
]);

// ── File resolution ──────────────────────────────────────────────────

function resolveSkillsDir(): string {
  if (process.env.KEVLAR_SKILLS_DIR) {
    return path.resolve(process.env.KEVLAR_SKILLS_DIR);
  }
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, "..", "..");
  return path.join(repoRoot, "skills");
}

function resolveAliasMapPath(locale: string): string {
  return path.join(resolveSkillsDir(), "templates", "alias-maps", `${locale}.json`);
}

// ── Internal cache ───────────────────────────────────────────────────

/** Cached alias maps keyed by locale. Cleared via invalidateAliasCache(). */
const _aliasCache = new Map<string, PromptAliasMap | null>();

/** Clear the alias map cache — call after locale change or map update. */
export function invalidateAliasCache(): void {
  _aliasCache.clear();
}

// ── Loader ───────────────────────────────────────────────────────────

function loadAliasMapUncached(locale: string): PromptAliasMap | null {
  const mapPath = resolveAliasMapPath(locale);
  try {
    const raw = fs.readFileSync(mapPath, "utf-8");
    const map = JSON.parse(raw) as PromptAliasMap;
    if (!map.mappings || typeof map.mappings !== "object") {
      logger.warn("Alias map has invalid mappings structure", {
        event: "alias_map_invalid",
        locale,
        path: mapPath,
      });
      return null;
    }

    // Runtime integrity check: embedded baseline + internal hash
    if (!hashGuardVerifyAliasMap(map)) {
      logger.error("Alias map failed runtime integrity check — possible tampering", {
        event: "alias_map_integrity_failed",
        locale,
        path: mapPath,
      });
      // Return the map anyway — hash guard already logged details.
      // Callers decide tier-appropriate fallback behavior.
    }

    return map;
  } catch {
    return null;
  }
}

function loadAliasMap(locale: string): PromptAliasMap | null {
  if (_aliasCache.has(locale)) {
    return _aliasCache.get(locale)!;
  }
  const map = loadAliasMapUncached(locale);
  _aliasCache.set(locale, map);
  return map;
}

// ── Resolver ─────────────────────────────────────────────────────────

/**
 * Check whether a segment value looks like an alias reference.
 *
 * Examples of alias references:
 *   "[PROTO:CORE_FRAMEWORK]"
 *   "[PROTO:CORE_STEPS]"
 *
 * Non-aliases pass through unchanged.
 */
function isAlias(value: string): boolean {
  return value.startsWith(ALIAS_PREFIX) && value.includes("]");
}

/**
 * Extract the alias ID from a reference string like "[PROTO:CORE_FRAMEWORK]".
 * Returns null if the string doesn't parse as a valid alias.
 */
function extractAliasId(value: string): string | null {
  const start = value.indexOf("[");
  const end = value.indexOf("]");
  if (start !== 0 || end === -1) return null;
  return value.slice(1, end);
}

/**
 * Check if an alias should be sent to LLM as-is (Plan B).
 * Currently all aliases are Plan A (client expands). Pro tier
 * can add specific aliases to the PLAN_B_ALIASES set.
 */
export function isPlanBAlias(aliasId: string): boolean {
  return PLAN_B_ALIASES.has(aliasId);
}

/**
 * Resolve a single segment value.
 *
 * - If the value is an alias → look up in the locale's alias map
 * - Plan A aliases: expand to full text (LLM gets the text)
 * - Plan B aliases: keep as alias reference (LLM operates on symbols)
 * - If the value is NOT an alias → return as-is
 * - If alias lookup fails → log warning, return the raw alias as fallback
 */
function resolveSegment(aliasId: string, map: PromptAliasMap, rawValue: string): string {
  // Plan B aliases stay as-is — LLM receives the symbolic reference.
  if (isPlanBAlias(aliasId)) {
    return rawValue;
  }

  // Plan A: lookup in map
  const resolved = map.mappings[aliasId];
  if (resolved !== undefined) {
    return resolved;
  }

  // Fallback: alias not found in map — log warning and try fallback locales
  logger.warn("Alias not found in locale map", {
    event: "alias_not_found",
    aliasId,
    locale: map.locale,
  });

  // Try zh-CN as universal fallback
  if (map.locale !== "zh-CN") {
    const fallbackMap = loadAliasMap("zh-CN");
    if (fallbackMap) {
      const fallback = fallbackMap.mappings[aliasId];
      if (fallback !== undefined) {
        logger.info("Alias resolved via zh-CN fallback", {
          event: "alias_fallback_resolved",
          aliasId,
          fromLocale: map.locale,
          toLocale: "zh-CN",
        });
        return fallback;
      }
    }
  }

  // Hard fallback: return the raw alias so the LLM at least sees a label
  logger.error("Alias unresolvable — using raw value as hard fallback", {
    event: "alias_hard_fallback",
    aliasId,
    locale: map.locale,
  });
  return rawValue;
}

/**
 * Resolve all alias references in a PromptSegments-like record.
 *
 * Walks every key → if the value is an alias reference, resolves it
 * via the current locale's alias map. Non-alias values pass through.
 *
 * @param segments - Raw PromptSegments (may contain alias references)
 * @param locale   - Target locale (defaults to getCurrentLanguage())
 * @returns Resolved segments where aliases are replaced with locale text
 */
export function resolvePromptAliases(
  segments: Record<string, string>,
  locale?: string,
): Record<string, string> {
  const loc = locale ?? getCurrentLanguage();
  const map = loadAliasMap(loc);

  if (!map) {
    logger.debug("No alias map for locale, returning raw segments", {
      event: "alias_map_missing",
      locale: loc,
    });
    return segments;
  }

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(segments)) {
    if (typeof value === "string" && isAlias(value)) {
      const aliasId = extractAliasId(value);
      if (aliasId) {
        resolved[key] = resolveSegment(aliasId, map, value);
        continue;
      }
    }
    // Not an alias — pass through unchanged (coerce to string)
    resolved[key] = String(value);
  }

  return resolved;
}

/**
 * Resolve a single segment value against the current locale.
 *
 * Convenience wrapper for cases where you only need one segment resolved.
 */
export function resolveSingleAlias(
  rawValue: string,
  locale?: string,
): string {
  if (!isAlias(rawValue)) return rawValue;

  const aliasId = extractAliasId(rawValue);
  if (!aliasId) return rawValue;

  const loc = locale ?? getCurrentLanguage();
  const map = loadAliasMap(loc);
  if (!map) return rawValue;

  return resolveSegment(aliasId, map, rawValue);
}

// ── Integrity ────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

/**
 * Compute SHA-256 of an alias map's mappings for integrity verification.
 */
export function computeAliasMapHash(mappings: Record<string, string>): string {
  const sorted = JSON.stringify(mappings, Object.keys(mappings).sort());
  return createHash("sha256").update(sorted, "utf-8").digest("hex");
}

/**
 * Verify an alias map's stored hash against its computed hash.
 */
export function verifyAliasMapIntegrity(map: PromptAliasMap): boolean {
  const computed = computeAliasMapHash(map.mappings);
  return computed === map.hash;
}
