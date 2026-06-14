const KEY_PATTERNS = [
  /sk-ant-[a-zA-Z0-9]{10,}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /(?:api|secret|private|token|key|credential|password)[-_]?[a-zA-Z0-9]{16,}/gi,
  /AIza[0-9A-Za-z_-]{35}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /gho_[a-zA-Z0-9]{36}/g,
  /xox[bpras]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,}/g,
];

export function scanForCredentials(text: string): string[] {
  const found: string[] = [];
  for (const pattern of KEY_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      for (const match of matches) {
        found.push(match.slice(0, 8) + "****");
      }
    }
  }
  return [...new Set(found)];
}

/**
 * Redact sensitive credential patterns in text by replacing them with masked versions.
 * MECP §7.2: Keep first 4 + last 4 chars, mask the middle.
 */
export function sanitizeOutput(output: string): string {
  let safe = output;
  for (const pattern of KEY_PATTERNS) {
    safe = safe.replace(pattern, (match) => {
      if (match.length <= 12) return "[REDACTED]";
      return match.slice(0, 4) + "*".repeat(match.length - 8) + match.slice(-4);
    });
  }
  return safe;
}

/**
 * Patterns that match the orchestration template's structural markers.
 * Injected content containing these could break out of the persona block.
 */
const ORCHESTRATION_BOUNDARIES = [
  /\*\*指令\*\*/g,
  /\*\*角色描述\*\*/g,
  /\*\*待评审内容\*\*/g,
  /\*\*发布平台\s*[&＆]\s*目标受众背景\*\*/g,
  /请严格按照该人设要求的输出格式作答[。.]?/g,
  /^#{1,6}\s/gm,
  /^-{3,}\s*$/gm,
];

export function stripPromptBoundaries(text: string): string {
  let result = text;
  for (const pattern of ORCHESTRATION_BOUNDARIES) {
    result = result.replace(pattern, "");
  }
  return result.trim();
}

/**
 * Sanitize user content before injecting into orchestration prompt boundaries.
 *
 * MECP §7.1: Prevents delimiter breakout by escaping XML entities and
 * replacing reserved boundary tokens.
 *
 * 1. Escape XML entities (& < >) to prevent tag injection.
 * 2. Replace known orchestration template boundary tokens with a safe marker.
 */
const BOUNDARY_TOKENS = [
  "<!-- KEVLAR_PERSONA_END:",
  "===== 人设边界",
  "===== 内容边界",
  "--- 隔离边界",
];

export function sanitizeForBoundary(content: string): string {
  let result = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  for (const token of BOUNDARY_TOKENS) {
    const escaped = token.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "gi"), "[RESERVED_BOUNDARY_TOKEN]");
  }

  return result;
}

export function wrapContent(content: string, tag = "content"): string {
  const suffix = Math.random().toString(36).substring(2, 8);
  const openTag = `<${tag}_${suffix}>`;
  const closeTag = `</${tag}_${suffix}>`;
  const escaped = content.replace(new RegExp(`</?${tag}_?[a-z0-9]*>`, "gi"), "");
  return `${openTag}\n${escaped}\n${closeTag}`;
}
