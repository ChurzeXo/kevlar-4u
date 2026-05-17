import { promises as fsp } from "fs";
import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

export interface PersonaMeta {
  id: string;
  name: string;
  name_en: string;
  version: string;
  author: string;
  tags: string[];
  description: string;
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
  return resolvedPath.startsWith(resolvedBase + path.sep);
}

// ── Persona parsing ──────────────────────────────────────────────────────────

export async function parsePersonaFile(filePath: string): Promise<Persona | null> {
  const fileName = path.basename(filePath);

  if (fileName.startsWith("_")) {
    return null;
  }

  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    console.warn(`[Kevlar] Failed to parse ${filePath}:`, err);
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
  };

  return {
    meta,
    systemPrompt: parsed.content.trim(),
    filePath,
  };
}

// ── Loading personas ─────────────────────────────────────────────────────────

export async function loadAllPersonas(skillsDir: string): Promise<Persona[]> {
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  const stat = fs.statSync(skillsDir);
  const currentMtime = stat.mtimeMs;

  if (personasCache && personasCache.mtime === currentMtime) {
    return personasCache.personas;
  }

  const files = (await fsp.readdir(skillsDir)).filter((f) => f.endsWith(".md"));
  const personas: Persona[] = [];

  for (const file of files) {
    const fullPath = path.join(skillsDir, file);
    const persona = await parsePersonaFile(fullPath);
    if (persona) {
      personas.push(persona);
    }
  }

  personasCache = { personas, mtime: currentMtime };
  return personas;
}

export async function loadPersonaById(
  skillsDir: string,
  id: string
): Promise<Persona | null> {
  const sanitizedId = id.replace(/[^a-z0-9_]/gi, "");
  if (!sanitizedId || sanitizedId !== id) {
    return null;
  }

  const fileName = `${sanitizedId}.md`;
  const filePath = path.join(skillsDir, fileName);

  if (!validateWritePath(filePath, skillsDir)) {
    return null;
  }

  return parsePersonaFile(filePath);
}

export async function loadPersonasByIds(
  skillsDir: string,
  ids: string[]
): Promise<Persona[]> {
  const results = await Promise.all(
    ids.map((id) => loadPersonaById(skillsDir, id))
  );
  return results.filter((p): p is Persona => p !== null);
}

// ── Writing personas ─────────────────────────────────────────────────────────

export async function writePersonaFile(
  skillsDir: string,
  meta: PersonaMeta,
  systemPrompt: string
): Promise<string> {
  const fileName = `${meta.id}.md`;
  const filePath = path.join(skillsDir, fileName);

  if (!validateWritePath(filePath, skillsDir)) {
    throw new Error("Invalid file path: path traversal detected");
  }

  const frontmatter = matter.stringify(systemPrompt, meta as unknown as Record<string, unknown>);

  await fsp.mkdir(skillsDir, { recursive: true });
  await fsp.writeFile(filePath, frontmatter, "utf-8");

  invalidatePersonasCache();
  return filePath;
}
