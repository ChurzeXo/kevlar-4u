const KEY_PATTERNS = [
  /sk-ant-[a-zA-Z0-9]{10,}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /(?:api|secret|private|token|key)[-_]?[a-zA-Z0-9]{16,}/gi,
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

export function wrapContent(content: string, tag = "content"): string {
  const suffix = Math.random().toString(36).substring(2, 8);
  const openTag = `<${tag}_${suffix}>`;
  const closeTag = `</${tag}_${suffix}>`;
  const escaped = content.replace(new RegExp(`</?${tag}_?[a-z0-9]*>`, "gi"), "");
  return `${openTag}\n${escaped}\n${closeTag}`;
}
