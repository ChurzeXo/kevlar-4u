import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

function resolveSkillsDir(): string {
  if (process.env.KEVLAR_SKILLS_DIR) {
    return path.resolve(process.env.KEVLAR_SKILLS_DIR);
  }
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, "..", "..");
  return path.join(repoRoot, "skills");
}

const LOG_FILE = path.join(resolveSkillsDir(), "tmp", "verification.log");

export function vlog(
  message: string,
  context?: Record<string, unknown>,
): void {
  const line =
    `[${new Date().toISOString()}] ${message}` +
    (context ? ` ${JSON.stringify(context)}` : "");

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch {
    // best-effort
  }
}
