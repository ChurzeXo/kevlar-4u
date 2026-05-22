import { promises as fsp, readdirSync } from "fs";
import * as path from "path";
import matter from "gray-matter";
import { logger } from "./logger.js";

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
  stance?: string;
  blindSpot?: string;
}

export interface Persona {
  meta: PersonaMeta;
  systemPrompt: string;
  filePath: string;
}

// ── Cache for loadAllPersonas ────────────────────────────────────────────────

let personasCache: { personas: Persona[]; mtime: number } | null = null;

export function invalidatePersonasCache(): void {
  personasCache = null;
}

// ── Path validation ──────────────────────────────────────────────────────────

export function validateWritePath(filePath: string, baseDir: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir);
  const relative = path.relative(resolvedBase, resolvedPath);
  // Relative must not start with '..' (which means it escaped baseDir)
  // and must not be empty (which means filePath === baseDir itself)
  return !relative.startsWith("..") && relative !== "";
}

// ── Persona parsing ─────────────────────────────────────────────────────────

export async function parsePersonaFile(filePath: string): Promise<Persona | null> {
  const fileName = path.basename(filePath);

  if (fileName.startsWith("_")) {
    return null;
  }

  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf-8");
  } catch (err) {
    logger.warn("Failed to read persona file", { event: "file_read_error", path: filePath });
    return null;
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    logger.warn("Failed to parse persona file", {
      event: "parse_error",
      path: filePath,
      error: String(err),
    });
    return null;
  }

  const data = parsed.data;

  if (!data.id || !data.name) {
    return null;
  }

  const meta: PersonaMeta = {
    id: String(data.id),
    name: String(data.name || ""),
    name_en: String(data.name_en || ""),
    version: String(data.version || "1.0.0"),
    author: String(data.author || "unknown"),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    description: String(data.description || ""),
    culturalContext: data.culturalContext ? String(data.culturalContext) : undefined,
    authorRelation: data.authorRelation ? String(data.authorRelation) : undefined,
    stance: data.stance ? String(data.stance) : undefined,
    blindSpot: data.blindSpot ? String(data.blindSpot) : undefined,
  };

  return {
    meta,
    systemPrompt: parsed.content.trim(),
    filePath,
  };
}

// ── Directory existence check (async) ──────────────────────────────────────

async function ensureDirExists(dirPath: string): Promise<boolean> {
  try {
    await fsp.access(dirPath);
    return true;
  } catch {
    return false;
  }
}

// ── Loading personas ─────────────────────────────────────────────────────────

export async function loadAllPersonas(skillsDir: string): Promise<Persona[]> {
  const dirExists = await ensureDirExists(skillsDir);
  if (!dirExists) {
    logger.debug("Skills directory does not exist", { event: "dir_not_found", path: skillsDir });
    return [];
  }

  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(skillsDir);
  } catch (err) {
    logger.error("Failed to stat skills directory", {
      event: "stat_error",
      path: skillsDir,
      error: String(err),
    });
    return [];
  }
  const currentMtime = stat.mtimeMs;

  if (personasCache && personasCache.mtime === currentMtime) {
    logger.debug("Returning cached personas", {
      event: "cache_hit",
      count: personasCache.personas.length,
    });
    return personasCache.personas;
  }

  let files: string[];
  try {
    files = readdirSync(skillsDir, { recursive: true })
      .filter((f): f is string => typeof f === "string" && f.endsWith(".md"));
  } catch (err) {
    logger.error("Failed to read skills directory", {
      event: "readdir_error",
      path: skillsDir,
      error: String(err),
    });
    return [];
  }

  logger.debug("Loading personas from directory", { event: "loading_personas", count: files.length });

  const personas: Persona[] = [];

  for (const file of files) {
    const fullPath = path.join(skillsDir, file);
    const persona = await parsePersonaFile(fullPath);
    if (persona) {
      personas.push(persona);
    }
  }

  personasCache = { personas, mtime: currentMtime };
  logger.info("Personas loaded", { event: "personas_loaded", count: personas.length });
  return personas;
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

  const all = await loadAllPersonas(skillsDir);
  return all.find((p) => p.meta.id === id) || null;
}

export async function loadPersonasByIds(
  skillsDir: string,
  ids: string[]
): Promise<Persona[]> {
  const results = await Promise.all(ids.map((id) => loadPersonaById(skillsDir, id)));
  return results.filter((p): p is Persona => p !== null);
}

// ── Writing personas ─────────────────────────────────────────────────────────

export async function writePersonaFile(
  skillsDir: string,
  meta: PersonaMeta,
  personaDescription: string,
  subDir?: string
): Promise<string> {
  const fileName = `${meta.id}.md`;
  const filePath = subDir
    ? path.join(skillsDir, subDir, fileName)
    : path.join(skillsDir, fileName);

  if (!validateWritePath(filePath, skillsDir)) {
    logger.warn("Path traversal attempt in writePersonaFile", {
      event: "path_traversal",
      path: filePath,
    });
    throw new Error("Invalid file path: path traversal detected");
  }

  const frontmatter = matter.stringify(
    personaDescription,
    meta as unknown as Record<string, unknown>
  );

  try {
    await fsp.mkdir(subDir ? path.join(skillsDir, subDir) : skillsDir, { recursive: true });
    await fsp.writeFile(filePath, frontmatter, "utf-8");
    logger.info("Persona file written", { event: "file_written", path: filePath, id: meta.id });
  } catch (err) {
    logger.error("Failed to write persona file", {
      event: "write_error",
      path: filePath,
      error: String(err),
    });
    throw err;
  }

  invalidatePersonasCache();
  return filePath;
}
