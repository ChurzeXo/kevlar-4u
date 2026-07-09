import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import type { PromptSegments } from "./promptTypes.js";
import { resolvePromptAliases } from "../execution/promptAlias.js";
import { verifyPromptIntegrity } from "../execution/promptHashGuard.js";
import { logger } from "../utils/observability.js";

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

  // Pro templates come from server via SaaSClient; if local file is absent,
  // fall back to Free tier gracefully.
  if (tier === "pro" && !fs.existsSync(filePath)) {
    return loadPromptSegments("free");
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const segments = JSON.parse(raw) as PromptSegments;

  // Resolve Evidence Aliases — Plan A (80%): client expands aliases → LLM gets full text
  // Plan B aliases (reserved for Pro core IP) pass through to LLM as-is.
  const resolved = resolvePromptAliases(segments as unknown as Record<string, string>) as unknown as PromptSegments;

  // P0 Runtime hash integrity check
  const integrity = verifyPromptIntegrity(resolved as unknown as Record<string, string>);
  if (!integrity.ok) {
    if (tier === "pro") {
      logger.error("Pro prompt integrity check failed, falling back to Free tier", {
        event: "prompt_integrity_pro_fallback",
        failures: integrity.failures,
      });
      return loadPromptSegments("free");
    }
    // Free mode: log error but continue serving (risk flagged, not blocked)
    logger.error("Free prompt integrity check failed — possible tampering, continuing with risk", {
      event: "prompt_integrity_free_risk",
      failures: integrity.failures,
    });
  }

  return resolved;
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
