import { promises as fsp } from "fs";
import * as path from "path";
import * as fs from "fs";
import { logger, getErrorInfo } from "./observability.js";

export interface PersonaMeta {
  id: string;
  name: string;
  name_en: string;
  version: string;
  author: string;
  tags: string[];
  description: string;
  culturalContext?: string;
  authorRelation?: string;
  /** @deprecated Use dimensionBias instead. Kept for backward-compatible JSON parsing. */
  stance?: string | string[];
  /** Dimension focus preferences — which offensive dimensions this persona weighs more heavily */
  dimensionBias?: import("../execution/dimensions.js").DimensionBias;
  blindSpot?: string;
  gender?: string;
  ageRange?: string;
  tone?: string | string[];
  /** AI-generated behavior hints for each persona attribute */
  behaviorHints?: PersonaBehaviorHints;
  /** RST v1 四层互联网反应模拟人格配置 */
  rst?: import("../execution/dimensions.js").RSTConfig;
}

export interface PersonaBehaviorHints {
  ageRange?: string;
  gender?: string;
  tags?: string;
  culturalContext?: string;
  perspective?: string;
  blindSpot?: string;
  authorRelation?: string;
}

export interface Persona {
  meta: PersonaMeta;
  systemPrompt: string;
  filePath: string;
}

// ── File naming ─────────────────────────────────────────────────────────────

const AUDITORS_FILENAME = "auditors.json";

const PLATFORM_FILENAMES: Record<string, string> = {
  "小红书": "xiaohongshu.json",
  "抖音": "douyin.json",
  "微博": "weibo.json",
  "B站": "bilibili.json",
  "Bilibili": "bilibili.json",
  "知乎": "zhihu.json",
  "Twitter": "twitter.json",
  "X": "x.json",
  "微信": "wechat.json",
  "微信公众号": "wechat_official.json",
  "Instagram": "instagram.json",
  "Reddit": "reddit.json",
  "YouTube": "youtube.json",
};

const FALLBACK_FILENAME = "fallback.json";

// ── In-memory index ─────────────────────────────────────────────────────────

interface PersonasIndex {
  byId: Map<string, Persona>;
  byTag: Map<string, Persona[]>;
  mtime: number;
}

let cachedIndex: PersonasIndex | null = null;

/**
 * Structure of a persona file on disk.
 */
interface PersonasFile {
  version: string;
  last_updated: string;
  personas: Record<string, {
    meta: PersonaMeta;
    systemPrompt: string;
  }>;
}

export function invalidatePersonasCache(): void {
  cachedIndex = null;
}

// ── Path validation (kept for backward compat with deletePersonaTool) ──────

export function validateWritePath(filePath: string, baseDir: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir);
  const relative = path.relative(resolvedBase, resolvedPath);
  return !relative.startsWith("..") && relative !== "";
}

// ── Filename resolution ─────────────────────────────────────────────────────

/**
 * Determine the target persona filename based on tags and id.
 */
export function resolveTargetFilename(meta: { tags: string[]; id: string }): string {
  if (meta.tags.includes("system_auditor")) return AUDITORS_FILENAME;
  for (const tag of meta.tags) {
    const fn = PLATFORM_FILENAMES[tag];
    if (fn) return fn;
  }
  return FALLBACK_FILENAME;
}

/**
 * Resolve filename from a platform name (used by create persona wizard).
 */
export function resolvePlatformFilename(platform: string): string | undefined {
  return PLATFORM_FILENAMES[platform];
}

export function isPersonaFilename(filename: string): boolean {
  return filename === AUDITORS_FILENAME
    || (filename.endsWith(".json") && Object.values(PLATFORM_FILENAMES).includes(filename))
    || filename === FALLBACK_FILENAME;
}

// ── Index management ───────────────────────────────────────────────────────

function buildIndex(personasFile: PersonasFile, filePath: string): PersonasIndex {
  const byId = new Map<string, Persona>();
  const byTag = new Map<string, Persona[]>();

  for (const [id, entry] of Object.entries(personasFile.personas)) {
    const persona: Persona = {
      meta: entry.meta,
      systemPrompt: entry.systemPrompt,
      filePath: filePath,
    };
    byId.set(id, persona);

    for (const tag of entry.meta.tags ?? []) {
      const existing = byTag.get(tag);
      if (existing) {
        existing.push(persona);
      } else {
        byTag.set(tag, [persona]);
      }
    }
  }

  return { byId, byTag, mtime: Date.now() };
}

function removePersonaFromByTag(byTag: Map<string, Persona[]>, persona: Persona): void {
  for (const tag of persona.meta.tags ?? []) {
    const list = byTag.get(tag);
    if (!list) continue;
    const idx = list.indexOf(persona);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) byTag.delete(tag);
  }
}

function mergeIndex(target: PersonasIndex, source: PersonasIndex): void {
  for (const [id, persona] of source.byId) {
    const existing = target.byId.get(id);
    if (existing) {
      removePersonaFromByTag(target.byTag, existing);
    }
    target.byId.set(id, persona);
  }
  for (const [tag, list] of source.byTag) {
    const existing = target.byTag.get(tag);
    if (existing) {
      existing.push(...list);
    } else {
      target.byTag.set(tag, [...list]);
    }
  }
  target.mtime = Math.max(target.mtime, source.mtime);
}

/**
 * Discover all persona files in skillsDir by scanning for .json files
 * whose top-level structure contains a `personas` key.
 */
async function discoverPersonaFiles(skillsDir: string): Promise<string[]> {
  if (!fs.existsSync(skillsDir)) return [];
  const entries = fs.readdirSync(skillsDir);
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(skillsDir, entry);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.personas) {
        files.push(filePath);
      }
    } catch {
      continue;
    }
  }
  return files;
}

async function loadIndex(skillsDir: string): Promise<PersonasIndex | null> {
  if (cachedIndex) return cachedIndex;

  const personaFiles = await discoverPersonaFiles(skillsDir);
  if (personaFiles.length === 0) return null;

  const combined: PersonasIndex = { byId: new Map(), byTag: new Map(), mtime: 0 };

  for (const filePath of personaFiles) {
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, "utf-8");
    } catch (err) {
      logger.error("Failed to read persona file", {
        event: "persona_read_error",
        path: filePath,
        error: getErrorInfo(err).code,
        message: getErrorInfo(err).message,
      });
      continue;
    }

    let parsed: PersonasFile;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.error("Failed to parse persona file", {
        event: "persona_parse_error",
        path: filePath,
        error: getErrorInfo(err).code,
        message: getErrorInfo(err).message,
      });
      continue;
    }

    const index = buildIndex(parsed, filePath);
    mergeIndex(combined, index);
  }

  cachedIndex = combined;
  return combined;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function parsePersonaFile(_filePath: string): Promise<Persona | null> {
  logger.warn("parsePersonaFile(filePath) is deprecated in Phase 1 JSON migration. Use loadAllPersonas or loadPersonaById instead.", {
    event: "deprecated_parsePersonaFile",
  });
  return null;
}

export async function loadAllPersonas(skillsDir: string): Promise<Persona[]> {
  const index = await loadIndex(skillsDir);
  if (!index) return [];
  return Array.from(index.byId.values());
}

export async function loadPersonaById(
  skillsDir: string,
  id: string
): Promise<Persona | null> {
  const sanitizedId = id.replace(/[^a-z0-9_]/gi, "");
  if (!sanitizedId || sanitizedId !== id) {
    logger.warn("Invalid persona ID format", { event: "invalid_id", id });
    return null;
  }

  const index = await loadIndex(skillsDir);
  if (!index) return null;
  return index.byId.get(id) || null;
}

export async function loadPersonasByIds(
  skillsDir: string,
  ids: string[]
): Promise<Persona[]> {
  const results = await Promise.all(ids.map((id) => loadPersonaById(skillsDir, id)));
  return results.filter((p): p is Persona => p !== null);
}

/**
 * Get personas filtered by a specific tag (e.g. platform name, system_auditor).
 */
export async function loadPersonasByTag(skillsDir: string, tag: string): Promise<Persona[]> {
  const index = await loadIndex(skillsDir);
  if (!index) return [];
  return index.byTag.get(tag) || [];
}

/**
 * Load only system auditors (from auditors.json).
 */
export async function loadSystemAuditors(skillsDir: string): Promise<Persona[]> {
  const filePath = path.join(skillsDir, AUDITORS_FILENAME);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const parsed: PersonasFile = JSON.parse(raw);
    return Object.entries(parsed.personas).map(([id, entry]) => ({
      meta: entry.meta,
      systemPrompt: entry.systemPrompt,
      filePath,
    }));
  } catch {
    return [];
  }
}

// ── Writing personas ───────────────────────────────────────────────────────

export async function writePersonaFile(
  skillsDir: string,
  meta: PersonaMeta,
  personaDescription: string,
  _subDir?: string
): Promise<string> {
  const filename = resolveTargetFilename(meta);
  const filePath = path.join(skillsDir, filename);
  const id = meta.id;

  let data: PersonasFile;
  if (fs.existsSync(filePath)) {
    try {
      const raw = await fsp.readFile(filePath, "utf-8");
      data = JSON.parse(raw);
    } catch {
      data = { version: "1.0.0", last_updated: new Date().toISOString().split("T")[0], personas: {} };
    }
  } else {
    data = { version: "1.0.0", last_updated: new Date().toISOString().split("T")[0], personas: {} };
  }

  data.personas[id] = {
    meta,
    systemPrompt: personaDescription,
  };
  data.last_updated = new Date().toISOString().split("T")[0];

  try {
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    logger.info("Persona written", { event: "persona_written", id, file: filename });
  } catch (err) {
    logger.error("Failed to write persona file", {
      event: "persona_write_error",
      path: filePath,
      error: getErrorInfo(err).code,
      message: getErrorInfo(err).message,
    });
    throw err;
  }

  invalidatePersonasCache();
  return filePath;
}

/**
 * Remove a persona from the correct file by ID. Returns true if deleted, false if not found.
 */
export async function deletePersonaFromJson(skillsDir: string, id: string): Promise<boolean> {
  const personaFiles = await discoverPersonaFiles(skillsDir);

  for (const filePath of personaFiles) {
    try {
      const raw = await fsp.readFile(filePath, "utf-8");
      const data: PersonasFile = JSON.parse(raw);

      if (data.personas?.[id]) {
        delete data.personas[id];
        data.last_updated = new Date().toISOString().split("T")[0];
        await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");

        invalidatePersonasCache();
        logger.info("Persona deleted", { event: "persona_deleted", id, file: path.basename(filePath) });
        return true;
      }
    } catch (err) {
      logger.warn("Error scanning persona file for deletion", {
        event: "persona_delete_scan_error",
        path: filePath,
        error: getErrorInfo(err).code,
      });
      continue;
    }
  }

  logger.warn("Persona not found for deletion", { event: "persona_delete_not_found", id });
  return false;
}

/**
 * Collect all existing persona IDs across all persona files.
 */
export async function collectAllPersonaIds(skillsDir: string): Promise<Set<string>> {
  const personas = await loadAllPersonas(skillsDir);
  return new Set(personas.map(p => p.meta.id));
}
