import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import type { PromptSegments } from "./promptTypes.js";

export type PromptTier = "free" | "pro";

function resolveSkillsDir(): string {
  if (process.env.KEVLAR_SKILLS_DIR) {
    return path.resolve(process.env.KEVLAR_SKILLS_DIR);
  }
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, "..", "..");
  return path.join(repoRoot, "skills");
}

export function loadPromptSegments(tier: PromptTier): PromptSegments {
  const skillsDir = resolveSkillsDir();
  const filePath = path.join(skillsDir, "templates", `${tier}.json`);
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as PromptSegments;
}

export function loadPromptSegmentsOrNull(tier: PromptTier): PromptSegments | null {
  try {
    return loadPromptSegments(tier);
  } catch {
    return null;
  }
}

export function writePromptSegmentsFile(tier: PromptTier, segments: PromptSegments): void {
  const skillsDir = resolveSkillsDir();
  const dirPath = path.join(skillsDir, "templates");
  fs.mkdirSync(dirPath, { recursive: true });
  const filePath = path.join(dirPath, `${tier}.json`);
  fs.writeFileSync(filePath, JSON.stringify(segments, null, 2), "utf-8");
}
