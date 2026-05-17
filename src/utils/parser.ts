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

  const { data, content } = matter(raw);

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
    systemPrompt: content.trim(),
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
 */
export function loadPersonaById(
  skillsDir: string,
  id: string
): Persona | null {
  const all = loadAllPersonas(skillsDir);
  return all.find((p) => p.meta.id === id) ?? null;
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

  const frontmatter = matter.stringify(systemPrompt, meta as unknown as Record<string, unknown>);

  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(filePath, frontmatter, "utf-8");

  return filePath;
}
