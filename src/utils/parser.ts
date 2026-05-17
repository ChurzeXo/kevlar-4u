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

/**
 * 安全验证：确保路径在指定目录内，防止路径遍历攻击
 */
function validatePath(filePath: string, baseDir: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir);
  return resolvedPath.startsWith(resolvedBase + path.sep);
}

/**
 * Parse a single persona .md file.
 * Returns null if the file is a template or lacks required frontmatter.
 */
export function parsePersonaFile(filePath: string): Persona | null {
  const fileName = path.basename(filePath);

  // Skip template files
  if (fileName.startsWith("_")) {
    return null;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
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

  // Validate required fields
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

/**
 * Load all personas from the skills/ directory.
 */
export function loadAllPersonas(skillsDir: string): Persona[] {
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  const personas: Persona[] = [];

  for (const file of files) {
    const fullPath = path.join(skillsDir, file);
    const persona = parsePersonaFile(fullPath);
    if (persona) {
      personas.push(persona);
    }
  }

  return personas;
}

/**
 * Load a single persona by its id.
 * Optimized: loads only the specific file instead of all personas.
 */
export function loadPersonaById(
  skillsDir: string,
  id: string
): Persona | null {
  // Sanitize ID to prevent path traversal
  const sanitizedId = id.replace(/[^a-z0-9_]/gi, "");
  if (!sanitizedId || sanitizedId !== id) {
    return null;
  }

  const fileName = `${sanitizedId}.md`;
  const filePath = path.join(skillsDir, fileName);

  // Security check: ensure file is within skillsDir
  if (!validatePath(filePath, skillsDir)) {
    return null;
  }

  return parsePersonaFile(filePath);
}

/**
 * Load multiple personas by their ids efficiently.
 * Single directory scan for all requested personas.
 */
export function loadPersonasByIds(
  skillsDir: string,
  ids: string[]
): Persona[] {
  const all = loadAllPersonas(skillsDir);
  const idSet = new Set(ids.map((id) => id.replace(/[^a-z0-9_]/gi, "")));
  return all.filter((p) => idSet.has(p.meta.id));
}

/**
 * Validate that a file path is safe to write/delete within skillsDir.
 */
export function validateWritePath(
  filePath: string,
  skillsDir: string
): boolean {
  // Ensure parent directory is skillsDir
  const resolvedPath = path.resolve(filePath);
  const resolvedDir = path.resolve(skillsDir);
  return resolvedPath.startsWith(resolvedDir + path.sep);
}

/**
 * Write a new persona file to the skills directory.
 * Returns the path of the created file.
 */
export function writePersonaFile(
  skillsDir: string,
  meta: PersonaMeta,
  systemPrompt: string
): string {
  const fileName = `${meta.id}.md`;
  const filePath = path.join(skillsDir, fileName);

  // Security check
  if (!validateWritePath(filePath, skillsDir)) {
    throw new Error("Invalid file path: path traversal detected");
  }

  const frontmatter = matter.stringify(systemPrompt, meta as unknown as Record<string, unknown>);

  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(filePath, frontmatter, "utf-8");

  return filePath;
}
