/**
 * Web Search Enhancement Module
 *
 * Provides web search capabilities for system auditors to improve accuracy.
 * Currently supports:
 * - network_culture_risk: Search for latest internet slang/memes
 * - factual_integrity: Verify facts and data
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface WebSearchConfig {
  /** Enable/disable web search */
  enabled: boolean;
  /** Search function to use */
  searchFn?: WebSearchFunction;
  /** Maximum number of search results per query */
  maxResults?: number;
  /** Timeout for search operations (ms) */
  timeoutMs?: number;
}

export type WebSearchFunction = (
  query: string,
  options?: { maxResults?: number }
) => Promise<WebSearchResult>;

export interface WebSearchResult {
  query: string;
  results: WebSearchItem[];
  timestamp: number;
}

export interface WebSearchItem {
  title: string;
  snippet: string;
  source: string;
  url?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Wrap an async operation with a timeout
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(fallback), timeoutMs)
    ),
  ]);
}

// ── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Get web context for a specific auditor dimension
 */
export async function getWebContextForAuditor(
  auditorId: string,
  content: string,
  searchFn: WebSearchFunction,
  options?: { maxResults?: number; timeoutMs?: number }
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  switch (auditorId) {
    case "network_culture_risk":
      return await getNetworkCultureContext(content, searchFn, options, timeoutMs);
    case "factual_integrity":
      return await getFactualContext(content, searchFn, options, timeoutMs);
    default:
      return "";
  }
}

// ── Network Culture Risk ───────────────────────────────────────────────────

/**
 * Extract suspicious terms that might be internet slang or memes
 */
function extractSuspiciousTerms(content: string): string[] {
  const terms = new Set<string>();

  // 1. 谐音梗检测：XX房、XX区、XX星
  const homophonePatterns = /[\u4e00-\u9fa5]{1,4}[房区星球]/g;
  const homophoneMatches = content.matchAll(homophonePatterns);
  for (const match of homophoneMatches) {
    terms.add(match[0]);
  }

  // 2. 缩写检测：2-6个字母的英文缩写
  const abbreviationPattern = /\b[A-Za-z]{2,6}\b/g;
  const abbreviations = content.matchAll(abbreviationPattern);
  for (const match of abbreviations) {
    const term = match[0].toLowerCase();
    // 过滤常见英文单词
    if (!COMMON_ENGLISH_WORDS.has(term)) {
      terms.add(match[0]);
    }
  }

  // 3. 数字暗语检测
  const numberSecretPattern = /\b\d{2,6}\b/g;
  const numberSecrets = content.matchAll(numberSecretPattern);
  for (const match of numberSecrets) {
    terms.add(match[0]);
  }

  // 4. Emoji 组合检测
  const emojiPattern = /[\p{Emoji}]{2,}/gu;
  const emojis = content.matchAll(emojiPattern);
  for (const match of emojis) {
    terms.add(match[0]);
  }

  // 5. 特殊符号组合
  const specialPattern = /[~～]{2,}|[!！]{2,}|[?？]{2,}/g;
  const specials = content.matchAll(specialPattern);
  for (const match of specials) {
    terms.add(match[0]);
  }

  return [...terms].slice(0, 5); // 限制最多5个搜索词
}

// Common English words to filter out
const COMMON_ENGLISH_WORDS = new Set([
  "the", "is", "at", "which", "on", "a", "an", "and", "or", "but",
  "in", "with", "to", "for", "of", "not", "no", "can", "had", "has",
  "have", "will", "do", "does", "did", "was", "were", "be", "been",
  "are", "am", "this", "that", "these", "those", "it", "its",
]);

/**
 * Search for network culture context
 */
async function getNetworkCultureContext(
  content: string,
  searchFn: WebSearchFunction,
  options?: { maxResults?: number },
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string> {
  const suspiciousTerms = extractSuspiciousTerms(content);
  if (suspiciousTerms.length === 0) {
    return "";
  }

  const searchResults = await Promise.all(
    suspiciousTerms.map(async (term) => {
      const searchPromise = searchFn(`${term} 含义 梗 网络用语`, {
        maxResults: options?.maxResults ?? 3,
      });
      return withTimeout(
        searchPromise.catch(() => ({ query: term, results: [], timestamp: Date.now() })),
        timeoutMs,
        { query: term, results: [], timestamp: Date.now() }
      );
    })
  );

  return formatNetworkCultureContext(searchResults);
}

/**
 * Format network culture context for LLM
 */
function formatNetworkCultureContext(results: WebSearchResult[]): string {
  const validResults = results.filter((r) => r.results.length > 0);
  if (validResults.length === 0) {
    return "";
  }

  const lines = ["以下是一些网络用语/梗的参考信息，供审计时参考：\n"];

  for (const result of validResults) {
    lines.push(`### 「${result.query}」`);
    for (const item of result.results.slice(0, 2)) {
      lines.push(`- ${item.title}: ${item.snippet}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Factual Integrity ──────────────────────────────────────────────────────

/**
 * Extract fact claims that need verification
 */
function extractFactClaims(content: string): string[] {
  const claims = new Set<string>();

  // 1. 数字数据：XX万、XX亿、XX%
  const numberPattern = /[\d,.]+\s*[万亿兆]?\s*[%％]?/g;
  const numbers = content.matchAll(numberPattern);
  for (const match of numbers) {
    // 获取数字前后的上下文
    const index = content.indexOf(match[0]);
    const start = Math.max(0, index - 20);
    const end = Math.min(content.length, index + match[0].length + 20);
    const context = content.slice(start, end).trim();
    if (context.length > 5) {
      claims.add(context);
    }
  }

  // 2. 引用声明：据...报道、...说、...表示
  const quotePattern = /(?:据|根据|据悉|听说|传闻)[^。，]{5,30}/g;
  const quotes = content.matchAll(quotePattern);
  for (const match of quotes) {
    claims.add(match[0]);
  }

  // 3. 时间声明：20XX年、去年、今年
  const timePattern = /(?:20\d{2}|去年|今年|上个月|昨天)[^。，]{3,30}/g;
  const times = content.matchAll(timePattern);
  for (const match of times) {
    claims.add(match[0]);
  }

  return [...claims].slice(0, 3); // 限制最多3个查询
}

/**
 * Search for factual context
 */
async function getFactualContext(
  content: string,
  searchFn: WebSearchFunction,
  options?: { maxResults?: number },
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string> {
  const factClaims = extractFactClaims(content);
  if (factClaims.length === 0) {
    return "";
  }

  const searchResults = await Promise.all(
    factClaims.map(async (claim) => {
      const searchPromise = searchFn(`${claim} 事实核查`, {
        maxResults: options?.maxResults ?? 3,
      });
      return withTimeout(
        searchPromise.catch(() => ({ query: claim, results: [], timestamp: Date.now() })),
        timeoutMs,
        { query: claim, results: [], timestamp: Date.now() }
      );
    })
  );

  return formatFactualContext(searchResults);
}

/**
 * Format factual context for LLM
 */
function formatFactualContext(results: WebSearchResult[]): string {
  const validResults = results.filter((r) => r.results.length > 0);
  if (validResults.length === 0) {
    return "";
  }

  const lines = ["以下是一些事实核查的参考信息，供审计时参考：\n"];

  for (const result of validResults) {
    lines.push(`### 待核实：「${result.query}」`);
    for (const item of result.results.slice(0, 2)) {
      lines.push(`- ${item.title}: ${item.snippet}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Utility ────────────────────────────────────────────────────────────────

/**
 * Create a default web search config (disabled by default)
 */
export function createDefaultWebSearchConfig(): WebSearchConfig {
  return {
    enabled: false,
    maxResults: 3,
    timeoutMs: 5000,
  };
}

/**
 * Check if a dimension supports web search
 */
export function isWebSearchSupported(auditorId: string): boolean {
  return WEB_SEARCH_SUPPORTED_DIMENSIONS.includes(auditorId);
}

/**
 * Dimensions that support web search enhancement
 */
export const WEB_SEARCH_SUPPORTED_DIMENSIONS = [
  "network_culture_risk",
  "factual_integrity",
];
