import type {
  Step0Result,
  Step0Finding,
  WildTranslation,
} from "../prompts/reviewWizard.js";
import {
  DIMENSION_SAFETY_RISK,
  type SafetyRiskConfig,
  type Step0FieldAccess,
} from "../execution/dimensions.js";

/**
 * Filter Step 0 fields per dimension access level:
 * - "all" → keep the original field
 * - "summary" → keep first 3 items + count hint
 * - "skip" → omit field entirely
 */
export function filterStep0Fields(
  step0Result: Step0Result,
  access: { wildTranslations: Step0FieldAccess; blackAtoms: Step0FieldAccess; attackCandidates: Step0FieldAccess; precedents: Step0FieldAccess },
): Step0Result {
  const result: Step0Result = { ...step0Result };

  if (access.wildTranslations === "skip") {
    result.wildTranslations = [];
  } else if (access.wildTranslations === "summary" && result.wildTranslations && result.wildTranslations.length > 3) {
    const kept = result.wildTranslations.slice(0, 3);
    kept.push({ original: `...${result.wildTranslations.length - 3} more items omitted (trimmed by dimension access rule)` } as any);
    result.wildTranslations = kept;
  }

  if (access.blackAtoms === "skip") {
    result.blackAtoms = [];
  } else if (access.blackAtoms === "summary" && result.blackAtoms && result.blackAtoms.length > 3) {
    result.blackAtoms = [...result.blackAtoms.slice(0, 3), `...${result.blackAtoms.length - 3} more items omitted`];
  }

  // attackCandidates: keep all unless skip (critical for all dimensions)
  if (access.attackCandidates === "skip") {
    result.attackCandidates = [];
  }

  // precedents: summary keeps first 3
  if (access.precedents === "skip") {
    delete result.precedents;
  } else if (access.precedents === "summary" && result.precedents && result.precedents.length > 3) {
    result.precedents = result.precedents.slice(0, 3);
  }

  return result;
}

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

// ── Risk direction inference (S2: semantic-preserving replacement) ──────────
// Maps decoded content to risk direction + impact without exposing raw terms.
// The patterns detect signal in the wildTranslation/decoded text and produce
// an academic sentence that preserves attack sharpness for sub-agents.

const RISK_DIRECTIONS: Array<{ patterns: RegExp[]; direction: string; impact: string }> = [
  {
    patterns: [/性|色|情|暧昧|擦边|暗示|双关|器官|肉体|裸|淫/i],
    direction: "非正式语义扩展",
    impact: "品牌形象受损（非正式语义联想）",
  },
  {
    patterns: [/政治|敏感|红线|违规|审查|意识形态|政权/i],
    direction: "社会议题边界",
    impact: "合规审查与舆论风险",
  },
  {
    patterns: [/歧视|侮辱|贬低|嘲讽|仇|恨|攻击|对立|鄙视/i],
    direction: "群体指向性评价",
    impact: "舆论对立与圈层冲突风险",
  },
  {
    patterns: [/黑话|圈层|暗语|烂梗|梗|缩写|加密/i],
    direction: "圈层符号误用",
    impact: "跨圈层语境误读风险",
  },
  {
    patterns: [/造假|虚假|假|伪劣|智商税|欺诈/i],
    direction: "事实性争议",
    impact: "品牌信誉与合规风险",
  },
  {
    patterns: [/违法|法律|广告法|绝对化|诱导|诈骗/i],
    direction: "合规性争议",
    impact: "法律审查与处罚风险",
  },
  {
    patterns: [/毒品|毒|药|违禁/i],
    direction: "违禁内容关联",
    impact: "平台封禁与法律风险",
  },
];

function detectRiskDirection(text: string): { direction: string; impact: string } {
  for (const entry of RISK_DIRECTIONS) {
    if (entry.patterns.some((p) => p.test(text))) {
      return { direction: entry.direction, impact: entry.impact };
    }
  }
  return { direction: "非标准网络用法", impact: "语境误读风险" };
}

/**
 * Generic sanitize: replace explicit text with direction-preserving academic form.
 */
function sanitizeText(text: string): string {
  if (!isLikelyExplicit(text)) return text;
  const { direction, impact } = detectRiskDirection(text);
  return `(语义已去敏) 非标准网络用法 — 风险方向：${direction} → ${impact}。子智能体应依据此方向判定攻击链完整性。`;
}

/**
 * Specialized sanitize for WildTranslation entries: includes the original term
 * and propagation verification context, so sub-agents retain attack signal.
 */
function sanitizeWildTranslation(wt: WildTranslation, webContextMap?: Record<string, string>): string {
  if (!isLikelyExplicit(wt.wildTranslation)) return wt.wildTranslation;
  const { direction, impact } = detectRiskDirection(wt.wildTranslation);
  const hasWebContext = webContextMap && Object.keys(webContextMap).length > 0;
  const hotness = hasWebContext ? "传播已验证（联网搜索确认该用法的网络存在性）" : "需进一步验证传播深度";
  return `解码分析：表达式「${wt.original}」在特定网络圈层中与非正式语义扩展存在强关联（${hotness}），潜在风险方向：${direction} → ${impact}。子智能体应据此判断攻击链完整性和传播杀伤力。`;
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
        wt.wildTranslation = sanitizeWildTranslation(wt, webContextMap);
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
        ? "搜索内容涉及非标准网络用法上下文，风险方向与传播热度已在解码分析中标注。"
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
        wt.wildTranslation = sanitizeWildTranslation(wt, webContextMap);
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
