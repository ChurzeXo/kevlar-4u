const KEY_PATTERNS = [
  /sk-ant-[a-zA-Z0-9]{10,}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /(?:api|secret|private|token|key)[-_]?[a-zA-Z0-9]{16,}/gi,
  /AIza[0-9A-Za-z_-]{35}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /gho_[a-zA-Z0-9]{36}/g,
  /xox[bpras]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,}/g,
];

const SUSPICIOUS_MARKERS = [
  "</content>",
  "</系统人设>",
  "</系统人设开始>",
];

export function escapeContent(content: string): { escaped: string; warnings: string[] } {
  const warnings: string[] = [];

  for (const marker of SUSPICIOUS_MARKERS) {
    if (content.toLowerCase().includes(marker.toLowerCase())) {
      warnings.push("Detected pattern that could interfere with prompt structure");
      break;
    }
  }

  return { escaped: content, warnings };
}

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

export function wrapContent(content: string, tag = "content"): string {
  const suffix = Math.random().toString(36).substring(2, 8);
  const openTag = `<${tag}_${suffix}>`;
  const closeTag = `</${tag}_${suffix}>`;
  const escaped = content.replace(new RegExp(`</?${tag}_?[a-z0-9]*>`, "gi"), "");
  return `${openTag}\n${escaped}\n${closeTag}`;
}
