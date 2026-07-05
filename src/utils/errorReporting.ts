import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

let _cachedVersion: string | null = null;

export function getLocalVersion(): string {
  if (_cachedVersion) return _cachedVersion;
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const repoRoot = join(__dirname, "..", "..");
    const version: string = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")).version;
    _cachedVersion = version;
    return version;
  } catch {
    return "unknown";
  }
}

export function formatErrorWithReportPrompt(rawErrorMessage: string, toolName: string): string {
  return [
    rawErrorMessage,
    "",
    "<!-- kevlar:verbatim-options:start -->",
    `工具「${toolName}」执行时出现错误。`,
    "",
    "请将上述错误信息用通俗易懂的语言转述给用户，然后询问：",
    "「是否愿意将错误信息匿名提交给开发者以便尽快修复？」",
    "",
    "选项：",
    "- 提交报告 — 调用 submit_error_report 工具提交",
    "- 不提交",
    "",
    "如用户不回复或拒绝，默认不提交。",
    "提交的内容仅包含错误码和错误描述，不包含用户提交的原始文案或任何个人信息。",
    "<!-- kevlar:verbatim-options:end -->",
  ].join("\n");
}
