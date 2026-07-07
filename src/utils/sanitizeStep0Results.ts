import type {
  Step0Result,
  Step0Finding,
  WildTranslation,
} from "../prompts/reviewWizard.js";
import { DIMENSION_SAFETY_RISK, type SafetyRiskConfig } from "../execution/dimensions.js";

const EXPLICIT_PATTERNS = [
  /\b性\s*行\s*为\b/, /\b性\s*暗\s*示\b/, /\b性\s*关\s*系\b/, /\b性\s*骚\s*扰\b/,
  /\b性\s*交\b/, /\b性\s*爱\b/, /\b性\s*感\b/, /\b色\s*情\b/, /\b低\s*俗\b/,
  /\b淫\s*秽\b/, /\b卖\s*淫\b/, /\b嫖\b/, /\b约\s*炮\b/, /\b上\s*床\b/,
  /\b开\s*房\b/, /\b处\s*女\b/, /\b鸡\b(?![A-Za-z])/, /\b鸭\b(?![A-Za-z])/,
  /\b生\s*殖\s*器\b/, /\b阴\s*茎\b/, /\b阴\s*道\b/, /\b乳\s*房\b/,
  /\bfuck\b/i, /\bshit\b/i, /\bdick\b/i, /\bcock\b/i, /\bcunt\b/i,
  /\bwhore\b/i, /\bslut\b/i, /\bporn\b/i, /\bsex\b/i, /\berotic\b/i,
  /\bvulgar\b/i, /\bobscene\b/i,
  /性行[为爲]/, /性暗[示⽰]/, /色情/, /低俗/, /淫[秽穢]/, /卖[淫婬]/,
  /[嫖闝]/, /[约約][炮砲]/, /上床/, /开[房房]/, /处女/,
  /生[殖植]器/, /[阴陰][茎莖]/, /[阴陰][道導]/, /[乳r][房房]/
];

function isLikelyExplicit(text: string): boolean {
  return EXPLICIT_PATTERNS.some((re) => re.test(text));
}

function sanitizeText(text: string): string {
  if (!isLikelyExplicit(text)) return text;
  return "(语义已去敏) 非标准网络用法 — 需 Host 兜底解码";
}

/**
 * Deep-clone and sanitize Step 0 results — per-dimension (skips LOW risk).
 */
export function sanitizeStep0Results(
  step0Result: Step0Result,
  auditorId: string,
  webContextMap?: Record<string, string>,
): { step0Result: Step0Result; webContextMap?: Record<string, string> } {
  const riskLevel = DIMENSION_SAFETY_RISK[auditorId]?.risk;
  if (riskLevel !== "HIGH") {
    return { step0Result, webContextMap };
  }

  const sanitized: Step0Result = JSON.parse(JSON.stringify(step0Result));
  let sanitizedWeb: Record<string, string> | undefined;

  if (sanitized.wildTranslations) {
    for (const wt of sanitized.wildTranslations) {
      if (isLikelyExplicit(wt.wildTranslation)) {
        wt.wildTranslation = sanitizeText(wt.wildTranslation);
      }
    }
  }

  if (sanitized.blackAtoms) {
    sanitized.blackAtoms = sanitized.blackAtoms.map((atom) =>
      isLikelyExplicit(atom) ? sanitizeText(atom) : atom,
    );
  }

  if (sanitized.attackCandidates) {
    for (const ac of sanitized.attackCandidates) {
      if (isLikelyExplicit(ac.keyword)) {
        ac.keyword = sanitizeText(ac.keyword);
      }
      if (isLikelyExplicit(ac.attackChain)) {
        ac.attackChain = sanitizeText(ac.attackChain);
      }
    }
  }

  if (webContextMap && Object.keys(webContextMap).length > 0) {
    sanitizedWeb = {};
    for (const [keyword, ctx] of Object.entries(webContextMap)) {
      const sanitizedKeyword = isLikelyExplicit(keyword) ? sanitizeText(keyword) : keyword;
      const sanitizedCtx = isLikelyExplicit(ctx)
        ? "(搜索内容已去敏) 搜索结果涉及非标准网络用法上下文，相关细节需在 Host 安全上下文中解码。"
        : ctx;
      sanitizedWeb[sanitizedKeyword] = sanitizedCtx;
    }
  }

  return { step0Result: sanitized, webContextMap: sanitizedWeb ?? webContextMap };
}

/**
 * Always-sanitize version for multi-auditor prompts (orchestration Turn 2,
 * subagent dispatch) where there's no single dimension ID — all explicit
 * content is replaced to avoid triggering host AI safety filters.
 */
export function sanitizeStep0ResultsGlobal(
  step0Result: Step0Result,
  webContextMap?: Record<string, string>,
): { step0Result: Step0Result; webContextMap?: Record<string, string> } {
  const sanitized: Step0Result = JSON.parse(JSON.stringify(step0Result));
  let sanitizedWeb: Record<string, string> | undefined;

  if (sanitized.wildTranslations) {
    for (const wt of sanitized.wildTranslations) {
      if (isLikelyExplicit(wt.wildTranslation)) {
        wt.wildTranslation = sanitizeText(wt.wildTranslation);
      }
    }
  }

  if (sanitized.blackAtoms) {
    sanitized.blackAtoms = sanitized.blackAtoms.map((atom) =>
      isLikelyExplicit(atom) ? sanitizeText(atom) : atom,
    );
  }

  if (sanitized.attackCandidates) {
    for (const ac of sanitized.attackCandidates) {
      if (isLikelyExplicit(ac.keyword)) {
        ac.keyword = sanitizeText(ac.keyword);
      }
      if (isLikelyExplicit(ac.attackChain)) {
        ac.attackChain = sanitizeText(ac.attackChain);
      }
    }
  }

  if (webContextMap && Object.keys(webContextMap).length > 0) {
    sanitizedWeb = {};
    for (const [keyword, ctx] of Object.entries(webContextMap)) {
      const sanitizedKeyword = isLikelyExplicit(keyword) ? sanitizeText(keyword) : keyword;
      const sanitizedCtx = isLikelyExplicit(ctx)
        ? "(搜索内容已去敏) 搜索结果涉及非标准网络用法上下文，相关细节需在 Host 安全上下文中解码。"
        : ctx;
      sanitizedWeb[sanitizedKeyword] = sanitizedCtx;
    }
  }

  return { step0Result: sanitized, webContextMap: sanitizedWeb ?? webContextMap };
}
