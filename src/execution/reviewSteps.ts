import { Persona } from "../utils/parser.js";
import { stripContext, type StrippedContent } from "../utils/stripContext.js";
import {
  type Step0Result,
  type Precedent,
  buildIsolatedSystemAuditorPrompt,
  buildIsolatedSystemAuditorMessage,
  buildCommonRiskRules,
  buildCoreReasoningFramework,
  buildPreAuditFinalizerPrompt,
} from "../prompts/reviewWizard.js";
import { calculateSynergy } from "./synergyCalculator.js";
import { logger, getErrorInfo } from "../utils/observability.js";
import type { PromptSegments } from "../subscription/promptTypes.js";
import { loadPromptSegments } from "../subscription/promptTemplates.js";

// ── Step type system ─────────────────────────────────────────────────────────

export type ReviewStepId =
  | "strip_context"
  | "bare_audit"
  | "full_audit"
  | "delta_analysis"
  | "merge_local_findings"
  | "cross_validation"
  | "synergy_weighting"
  | "final_arbitration"
  | "orchestration_step0"
  | "orchestration_audit"
  | "orchestration_final";

export type ReviewStepKind = "inline" | "orchestration_turn";

export interface BaseReviewStep {
  id: ReviewStepId;
  kind: ReviewStepKind;
}

export interface InlineStep extends BaseReviewStep {
  kind: "inline";
  run(ctx: ReviewStepContext): Promise<ReviewStepResult>;
}

export interface OrchestrationTurnStep extends BaseReviewStep {
  kind: "orchestration_turn";
  buildPrompt(ctx: ReviewStepContext): Promise<string>;
  resume(ctx: ReviewStepContext, hostResult: unknown): Promise<ReviewStepResult>;
}

export type AuditLlmCaller = (params: {
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
}) => Promise<{ content: string; stopReason?: string }>;

export interface ReviewStepContext {
  content: string;
  systemAuditors: Persona[];
  localFindings: any[];
  caller?: AuditLlmCaller;
  step0Result?: Step0Result;
  webContextMap?: Record<string, string>;
  precedents?: Precedent[];
  timingContext?: string;
  sendProgress?: (message: string) => void;
  stripped?: StrippedContent;
  bareFindings?: PreAuditDimensionResult[];
  fullFindings?: PreAuditDimensionResult[];
  deltaRisks?: { bareOnly: string[]; fullOnly: string[]; stable: string[] };
  mergedResults?: PreAuditDimensionResult[];
  crossValidatedResults?: PreAuditDimensionResult[];
  synergy?: {
    triggered: string[];
    overallMultiplier: number;
    levelUpgrades?: Array<{ dimension: string; from: string; to: string; reason: string }>;
    details?: Array<{ rule: any; matched: boolean }>;
  };
  prompts?: PromptSegments;
  /** Bundle-delivered synergy rules (overrides hardcoded defaults). */
  synergyRules?: Array<{
    dimensions: string[];
    condition: "ALL" | "ANY";
    multiplier: number;
    upgradeLevel: boolean;
    label: string;
  }>;
}

export interface ReviewStepResult {
  stepId: ReviewStepId;
  output: any;
}

// ── Pipeline types (extracted from wizard) ────────────────────────────────────

export interface PreAuditDimensionResult {
  id: string;
  name: string;
  findings: any[];
  level?: string;
}

export interface PreAuditReport {
  dimensions: PreAuditDimensionResult[];
  summary: string;
  riskProfile?: {
    timing_risk: string;
    context_risk: string;
    cultural_risk: string;
    narrative_power_risk: string;
    emotion_risk: string;
    symbol_risk: string;
    propagation_risk: string;
  };
  synergyFlags?: {
    triggered: string[];
    overallMultiplier: number;
    levelUpgrades?: Array<{
      dimension: string;
      from: string;
      to: string;
      reason: string;
    }>;
  };
  attackChainAnalysis?: string;
  worstCaseNarrative?: string;
  deltaRisks?: {
    bareOnly: string[];
    fullOnly: string[];
    stable: string[];
  };
  precedents?: Precedent[];
}

interface CrossValidationPair {
  source: string;
  validator: string;
  question: string;
}

const CROSS_VALIDATION_PAIRS: CrossValidationPair[] = [
  {
    source: "network_culture_risk",
    validator: "context_distortion",
    question:
      '以下内容被「暗语破译」标记为网络文化风险。请从「语境脱嵌」角度进行交叉验证，判断它们在真实语境下是否确实容易被断章取义或恶意曲解。请对每一项进行判定并输出 JSON。结构要求：{"findings": [{"keyword": "风险词", "status": "confirmed / downgraded / debunked", "reason": "说明判定理由", "suggestedLevel": "如果为 confirmed 或 downgraded，提供推荐等级 🔴 或 🟡"}]}',
  },
  {
    source: "context_distortion",
    validator: "network_culture_risk",
    question:
      '以下内容被「语境猎手」标记为语境脱嵌风险。请从「网络文化」角度进行交叉验证，判断它们是否确实在网络社区存在低俗暗语或恶意梗的隐晦含义。请对每一项进行判定并输出 JSON。结构要求：{"findings": [{"keyword": "风险词", "status": "confirmed / downgraded / debunked", "reason": "说明判定理由", "suggestedLevel": "如果为 confirmed 或 downgraded，提供推荐等级 🔴 或 🟡"}]}',
  },
  {
    source: "social_risk",
    validator: "factual_integrity",
    question:
      '以下内容被「社伦判官」标记为社会风险。请从「事实完整性」角度交叉验证：这些风险点是否有明确的事实硬伤或夸大陈述？还是纯粹基于情绪联想？请对每一项进行判定并输出 JSON。结构要求：{"findings": [{"keyword": "风险词", "status": "confirmed / downgraded / debunked", "reason": "说明判定理由", "suggestedLevel": "如果为 confirmed 或 downgraded，提供推荐等级 🔴 或 🟡"}]}',
  },
  {
    source: "legal_compliance",
    validator: "social_risk",
    question:
      '以下内容被「合规哨兵」标记为合规风险。请从「社会风险」角度交叉验证：这些合规问题是否可能在当前社会语境中触发负面的舆论情绪对立？请对每一项进行判定并输出 JSON。结构要求：{"findings": [{"keyword": "风险词", "status": "confirmed / downgraded / debunked", "reason": "说明判定理由", "suggestedLevel": "如果为 confirmed 或 downgraded，提供推荐等级 🔴 或 🟡"}]}',
  },
  {
    source: "cross_lingual_distortion",
    validator: "network_culture_risk",
    question:
      '以下内容被「跨界判官」标记为跨语言曲解风险。请从「网络文化」角度进行交叉验证：这些外文词在中文互联网上是否有现成的恶搞梗、表情包或黑话含义？请对每一项进行判定并输出 JSON。结构要求：{"findings": [{"keyword": "风险词", "status": "confirmed / downgraded / debunked", "reason": "说明判定理由", "suggestedLevel": "如果为 confirmed 或 downgraded，提供推荐等级 🔴 或 🟡"}]}',
  },
  {
    source: "network_culture_risk",
    validator: "cross_lingual_distortion",
    question:
      '以下内容被「暗语破译」标记为网络文化风险。请从「跨语言曲解」角度进行交叉验证：这些风险词是否涉及外文谐音、恶意机翻或文化水土不服？请对每一项进行判定并输出 JSON。结构要求：{"findings": [{"keyword": "风险词", "status": "confirmed / downgraded / debunked", "reason": "说明判定理由", "suggestedLevel": "如果为 confirmed 或 downgraded，提供推荐等级 🔴 或 🟡"}]}',
  },
];

// ── Shared utilities ──────────────────────────────────────────────────────────

function stripCodeFence(text: string): string {
  if (!text.startsWith("```")) return text;
  return text
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

export function getFindingsLevel(findings: any[]): string {
  let level = "🟢";
  for (const finding of findings) {
    if (finding.suggestedLevel === "🔴") return "🔴";
    if (finding.suggestedLevel === "🟡") level = "🟡";
  }
  return level;
}

function normalizeFinding(finding: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...finding };
  const suggestedLevel = String(finding.suggestedLevel || "").trim();
  if (suggestedLevel !== "🔴" && suggestedLevel !== "🟡") {
    normalized.suggestedLevel = "🟡";
  }
  return normalized;
}

export function normalizePreAuditDimensions(raw: unknown, systemAuditors: Persona[]): PreAuditDimensionResult[] {
  const auditorMeta = new Map(systemAuditors.map((auditor) => [auditor.meta.id, auditor.meta.name]));
  const source = Array.isArray(raw) ? raw : [];
  const normalized: PreAuditDimensionResult[] = [];
  const seen = new Set<string>();

  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id =
      typeof record.id === "string" && record.id.trim() ? record.id.trim() : `dimension_${normalized.length + 1}`;
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : auditorMeta.get(id) || id;
    const findings = Array.isArray(record.findings) ? record.findings : [];
    const cleanedFindings = findings
      .filter((finding: any) => finding && typeof finding === "object")
      .map((finding: any) => normalizeFinding(finding as Record<string, unknown>));
    normalized.push({ id, name, findings: cleanedFindings, level: getFindingsLevel(cleanedFindings) });
    seen.add(id);
  }

  for (const auditor of systemAuditors) {
    if (!seen.has(auditor.meta.id)) {
      normalized.push({ id: auditor.meta.id, name: auditor.meta.name, findings: [], level: "🟢" });
    }
  }

  return normalized;
}

export function mergeLocalFindingsIntoAudits(
  audits: PreAuditDimensionResult[],
  localFindings: any[],
): PreAuditDimensionResult[] {
  const merged = audits.map((audit) => ({ ...audit, findings: [...(audit.findings || [])] }));
  if (localFindings.length === 0) return merged;

  const networkAudit = merged.find((audit) => audit.id === "network_culture_risk");
  if (networkAudit) {
    networkAudit.findings.push(...localFindings);
  } else {
    merged.unshift({
      id: "local_rule_engine",
      name: "规则引擎",
      findings: localFindings,
      level: getFindingsLevel(localFindings),
    });
  }

  for (const audit of merged) {
    audit.level = getFindingsLevel(audit.findings || []);
  }

  return merged;
}

export function buildEmptyDeltaRisks(): { bareOnly: string[]; fullOnly: string[]; stable: string[] } {
  return { bareOnly: [], fullOnly: [], stable: [] };
}

// ── Inline step: Step 1 — Strip context ──────────────────────────────────────

export const stepStripContext: InlineStep = {
  id: "strip_context",
  kind: "inline",
  async run(ctx: ReviewStepContext): Promise<ReviewStepResult> {
    const stripped = stripContext(ctx.content);
    ctx.stripped = stripped;
    return { stepId: "strip_context", output: stripped };
  },
};

// ── Shared: run system auditors (bare + full) ────────────────────────────────

export async function runSystemAuditors(
  content: string,
  systemAuditors: Persona[],
  caller: AuditLlmCaller,
  timingContext?: string,
  localFindings: any[] = [],
  step0Result?: Step0Result,
  webContextMap?: Record<string, string>,
): Promise<PreAuditDimensionResult[]> {
  return Promise.all(
    systemAuditors.map(async (auditor) => {
      try {
        const auditContent =
          timingContext && auditor.meta.id === "social_risk" ? [content, "", timingContext].join("\n") : content;

        let webContext = "";
        if (webContextMap && Object.keys(webContextMap).length > 0) {
          const relevantEntries = Object.entries(webContextMap)
            .filter(([, ctx]) => ctx.length > 0)
            .map(([kw, ctx]) => `### 关键词「${kw}」\n${ctx}`);
          if (relevantEntries.length > 0) {
            webContext = `以下是针对本文案黑料原子的联网验证结果（Turn 1 已完成检索）：\n\n${relevantEntries.join("\n\n")}`;
          }
        }

        const response = await caller({
          systemPrompt: buildIsolatedSystemAuditorPrompt(auditor),
          messages: [
            {
              role: "user",
              content: buildIsolatedSystemAuditorMessage(auditContent, auditor, {
                localFindings,
                step0Result,
                timingContext: timingContext && auditor.meta.id === "social_risk" ? timingContext : undefined,
                webContext: webContext || undefined,
              }),
            },
          ],
          maxTokens: 2048,
        });
        const parsed = JSON.parse(stripCodeFence(response.content.trim()));
        return {
          id: auditor.meta.id,
          name: auditor.meta.name,
          findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        };
      } catch (err) {
        logger.warn("System auditor failed", {
          event: "system_auditor_failed",
          auditorId: auditor.meta.id,
          error: getErrorInfo(err).message,
        });
        return { id: auditor.meta.id, name: auditor.meta.name, findings: [] };
      }
    }),
  );
}

// ── Inline step: Step 2 — Bare-text audit ────────────────────────────────────

export const stepBareAudit: InlineStep = {
  id: "bare_audit",
  kind: "inline",
  async run(ctx: ReviewStepContext): Promise<ReviewStepResult> {
    const bareText = ctx.stripped?.bare ?? ctx.content;
    const bareOnlyAuditors = ctx.systemAuditors.filter(
      (a) =>
        a.meta.id === "context_distortion" ||
        a.meta.id === "network_culture_risk" ||
        a.meta.id === "cross_lingual_distortion",
    );
    const bareFindings =
      bareOnlyAuditors.length > 0
        ? await runSystemAuditors(
            bareText,
            bareOnlyAuditors,
            ctx.caller!,
            undefined,
            ctx.localFindings,
            ctx.step0Result,
            ctx.webContextMap,
          )
        : [];
    ctx.bareFindings = bareFindings;
    return { stepId: "bare_audit", output: bareFindings };
  },
};

// ── Inline step: Step 3 — Full-text audit ────────────────────────────────────

export const stepFullAudit: InlineStep = {
  id: "full_audit",
  kind: "inline",
  async run(ctx: ReviewStepContext): Promise<ReviewStepResult> {
    const auditorResults = await runSystemAuditors(
      ctx.content,
      ctx.systemAuditors,
      ctx.caller!,
      ctx.timingContext,
      ctx.localFindings,
      ctx.step0Result,
      ctx.webContextMap,
    );
    ctx.fullFindings = auditorResults;
    return { stepId: "full_audit", output: auditorResults };
  },
};

// ── Inline step: Step 4 — Delta analysis ─────────────────────────────────────

export function computeDeltaAnalysis(
  bareFindings: PreAuditDimensionResult[],
  fullFindings: PreAuditDimensionResult[],
): { bareOnly: string[]; fullOnly: string[]; stable: string[] } {
  const bareKeywords = [...new Set(bareFindings.flatMap((r) => r.findings.map((f: any) => f.keyword)))].filter(
    Boolean,
  ) as string[];
  const fullKeywords = [...new Set(fullFindings.flatMap((r) => r.findings.map((f: any) => f.keyword)))].filter(
    Boolean,
  ) as string[];

  const findOverlap = (kw: string, list: string[]): boolean => {
    return list.some(
      (item) =>
        item.toLowerCase() === kw.toLowerCase() ||
        item.toLowerCase().includes(kw.toLowerCase()) ||
        kw.toLowerCase().includes(item.toLowerCase()),
    );
  };

  const bareOnly = bareKeywords.filter((kw) => !findOverlap(kw, fullKeywords));
  const fullOnly = fullKeywords.filter((kw) => !findOverlap(kw, bareKeywords));
  const stable = [
    ...bareKeywords.filter((kw) => findOverlap(kw, fullKeywords)),
    ...fullKeywords.filter((kw) => findOverlap(kw, bareKeywords) && !bareKeywords.includes(kw)),
  ];

  return {
    bareOnly,
    fullOnly,
    stable: [...new Set(stable)],
  };
}

export const stepDeltaAnalysis: InlineStep = {
  id: "delta_analysis",
  kind: "inline",
  async run(ctx: ReviewStepContext): Promise<ReviewStepResult> {
    const bare = ctx.bareFindings ?? [];
    const full = ctx.fullFindings ?? [];
    const delta = computeDeltaAnalysis(bare, full);
    ctx.deltaRisks = delta;
    return { stepId: "delta_analysis", output: delta };
  },
};

// ── Inline step: Step 5 — Merge local findings ───────────────────────────────

export const stepMergeLocalFindings: InlineStep = {
  id: "merge_local_findings",
  kind: "inline",
  async run(ctx: ReviewStepContext): Promise<ReviewStepResult> {
    const fullResults = ctx.fullFindings ?? [];
    const merged = normalizePreAuditDimensions(
      mergeLocalFindingsIntoAudits(fullResults, ctx.localFindings),
      ctx.systemAuditors,
    );
    ctx.mergedResults = merged;
    return { stepId: "merge_local_findings", output: merged };
  },
};

// ── Inline step: Step 6 — Cross-validation ───────────────────────────────────

export async function crossValidateRiskyDimensions(
  content: string,
  phase1Results: PreAuditDimensionResult[],
  auditors: Persona[],
  samplingFn: AuditLlmCaller,
): Promise<PreAuditDimensionResult[]> {
  const riskyDimensions = phase1Results.filter((r) => r.findings && r.findings.length > 0);
  if (riskyDimensions.length === 0) return phase1Results;

  const validatorMap = new Map(auditors.map((a) => [a.meta.id, a]));
  const results = [...phase1Results.map((r) => ({ ...r, findings: [...r.findings] }))];

  for (const pair of CROSS_VALIDATION_PAIRS) {
    const sourceDim = results.find((r) => r.id === pair.source);
    if (!sourceDim || sourceDim.findings.length === 0) continue;

    const validatorAuditor = validatorMap.get(pair.validator);
    if (!validatorAuditor) continue;

    const findingsSummary = sourceDim.findings
      .map(
        (f, i: number) =>
          `${i + 1}. [${f.suggestedLevel || "🟡"}] ${f.keyword || ""} - ${f.trigger || f.riskDescription || ""}`,
      )
      .join("\n");

    try {
      const response = await samplingFn({
        systemPrompt: [
          `# [SYSTEM PROTOCOL] 防御性风险矩阵交叉验证沙盒`,
          ``,
          `## 【元规则】`,
          `1. 运行环境：真实隔离 LLM 沙盒；当前调用代表一名交叉验证审查员`,
          `2. 核心禁令：禁止使用第一人称发言；禁止输出任何修改建议、优化方向、文案润色或重写意见`,
          ``,
          buildCommonRiskRules(),
          ``,
          buildCoreReasoningFramework(),
          ``,
          `## 【你的审查员角色与原始规则】`,
          `- 审查员：${validatorAuditor.meta.name}（${validatorAuditor.meta.id}）`,
          `- 角色描述：${validatorAuditor.meta.description}`,
          ``,
          validatorAuditor.systemPrompt,
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [
              pair.question,
              "",
              `原始内容：${content}`,
              "",
              `「${sourceDim.name}」的发现：`,
              findingsSummary,
            ].join("\n"),
          },
        ],
        maxTokens: 1024,
      });

      const parsed = JSON.parse(stripCodeFence(response.content.trim()));
      const validatedFindings = Array.isArray(parsed.findings) ? parsed.findings : [];

      const validatorDim = results.find((r) => r.id === pair.validator);
      if (validatedFindings.length > 0) {
        for (const vf of validatedFindings) {
          const status = String(vf.status || "")
            .toLowerCase()
            .trim();
          const targetKeyword = String(vf.keyword || "").trim();

          if (status === "debunked") {
            sourceDim.findings = sourceDim.findings.filter((f) => String(f.keyword || "").trim() !== targetKeyword);
          } else if (status === "downgraded") {
            for (const f of sourceDim.findings) {
              if (String(f.keyword || "").trim() === targetKeyword) {
                f.suggestedLevel = "🟡";
                f.trigger = `[交叉验证降级 (验证方: ${validatorAuditor.meta.name})] ${f.trigger}`;
                f.riskDescription = `${f.riskDescription} (降级缘由: ${vf.reason || "未指明理由"})`;
              }
            }
          } else if (status === "confirmed") {
            if (validatorDim) {
              const exists = validatorDim.findings.some(
                (existing: any) => String(existing.keyword || "").trim() === targetKeyword,
              );
              if (!exists) {
                validatorDim.findings.push({
                  keyword: targetKeyword,
                  trigger: `[交叉验证确认 (源自: ${sourceDim.name})] ${vf.reason || "确认存在关联风险"}`,
                  riskDescription: vf.reason || "双向交叉验证增强确认",
                  suggestedLevel: vf.suggestedLevel || "🟡",
                  source: "cross_validation",
                });
              }
            }
          }
        }

        sourceDim.level = getFindingsLevel(sourceDim.findings);
        if (validatorDim) {
          validatorDim.level = getFindingsLevel(validatorDim.findings);
        }
      }
    } catch (err) {
      logger.warn("Cross-validation failed", {
        event: "cross_validation_failed",
        source: pair.source,
        validator: pair.validator,
        error: getErrorInfo(err).message,
      });
    }
  }

  return results;
}

export const stepCrossValidation: InlineStep = {
  id: "cross_validation",
  kind: "inline",
  async run(ctx: ReviewStepContext): Promise<ReviewStepResult> {
    const mergedResults = ctx.mergedResults ?? [];
    const crossValidated = await crossValidateRiskyDimensions(ctx.content, mergedResults, ctx.systemAuditors, ctx.caller!);
    ctx.crossValidatedResults = crossValidated;
    return { stepId: "cross_validation", output: crossValidated };
  },
};

// ── Inline step: Step 7 — Synergy weighting ──────────────────────────────────

export const stepSynergyWeighting: InlineStep = {
  id: "synergy_weighting",
  kind: "inline",
  async run(ctx: ReviewStepContext): Promise<ReviewStepResult> {
    const results = ctx.crossValidatedResults ?? [];
    const dimensionLevels: Record<string, string> = {};
    for (const dim of results) {
      dimensionLevels[dim.id] = dim.level ?? "🟢";
    }
    const timingFlag = ctx.localFindings.some((f: any) => f.timingWindowId) ? ["timing_risk"] : [];
    const synergy = calculateSynergy(dimensionLevels, timingFlag, ctx.synergyRules);
    ctx.synergy = synergy;
    return { stepId: "synergy_weighting", output: synergy };
  },
};

// ── Inline step: Step 8 — Final arbitration ──────────────────────────────────

export async function finalizePreAuditReport(
  content: string,
  localFindings: any[],
  mergedResults: PreAuditDimensionResult[],
  crossValidatedResults: PreAuditDimensionResult[],
  systemAuditors: Persona[],
  caller: AuditLlmCaller,
  synergy?: {
    triggered: string[];
    overallMultiplier: number;
    levelUpgrades?: Array<{ dimension: string; from: string; to: string; reason: string }>;
    details?: Array<{ rule: any; matched: boolean }>;
  },
  deltaRisks?: any,
  precedents?: Precedent[],
  prompts?: PromptSegments,
): Promise<PreAuditReport> {
  const segs = prompts ?? loadPromptSegments("free");
  const fallbackDimensions = normalizePreAuditDimensions(crossValidatedResults, systemAuditors);
  try {
    const response = await caller({
      systemPrompt: buildPreAuditFinalizerPrompt(systemAuditors, precedents, segs),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            content,
            localFindings,
            mergedResults,
            crossValidatedResults,
            synergy,
            deltaRisks,
          }),
        },
      ],
      maxTokens: 4096,
    });
    const parsed = JSON.parse(stripCodeFence(response.content.trim()));
    const dimensions = normalizePreAuditDimensions(parsed.dimensions, systemAuditors);
    return {
      dimensions,
      summary: parsed.summary || summarizeFallback(dimensions),
      riskProfile: parsed.riskProfile ?? undefined,
      synergyFlags: parsed.synergyFlags ?? undefined,
      attackChainAnalysis: parsed.attackChainAnalysis ?? undefined,
      worstCaseNarrative: parsed.worstCaseNarrative ?? undefined,
      deltaRisks: parsed.deltaRisks ?? undefined,
      precedents,
    };
  } catch (err) {
    logger.warn("Pre-audit finalizer failed, using deterministic summary", {
      event: "pre_audit_finalizer_failed",
      error: getErrorInfo(err).message,
    });
    if (synergy?.levelUpgrades && synergy.levelUpgrades.length > 0) {
      for (const upgrade of synergy.levelUpgrades) {
        const dim = fallbackDimensions.find((d) => d.id === upgrade.dimension);
        if (dim && dim.level === upgrade.from) {
          dim.level = upgrade.to;
        }
      }
    }
    return { dimensions: fallbackDimensions, summary: summarizeFallback(fallbackDimensions), precedents };
  }
}

function summarizeFallback(results: PreAuditDimensionResult[]): string {
  if (results.length === 0) return "未命中风险点";
  const riskyCount = results.filter((r) => r.findings && r.findings.length > 0).length;
  if (riskyCount === 0) return "全部维度通过";
  return `${riskyCount}/${results.length} 个维度存在风险发现`;
}

export const stepFinalArbitration: InlineStep = {
  id: "final_arbitration",
  kind: "inline",
  async run(ctx: ReviewStepContext): Promise<ReviewStepResult> {
    const crossValidated = ctx.crossValidatedResults ?? [];
    const mergedResults = ctx.mergedResults ?? [];
    const report = await finalizePreAuditReport(
      ctx.content,
      ctx.localFindings,
      mergedResults,
      crossValidated,
      ctx.systemAuditors,
      ctx.caller!,
      ctx.synergy,
      ctx.deltaRisks,
      ctx.precedents,
      ctx.prompts ?? loadPromptSegments("free"),
    );
    return { stepId: "final_arbitration", output: report };
  },
};

// ── Composite pipeline runner ─────────────────────────────────────────────────

export async function executeFullPipeline(
  content: string,
  systemAuditors: Persona[],
  localFindings: any[],
  caller: AuditLlmCaller,
  step0Result?: Step0Result,
  webContextMap?: Record<string, string>,
  precedents?: Precedent[],
  timingContext?: string,
  sendProgress?: (message: string) => void,
  prompts?: PromptSegments,
  synergyRules?: Array<{
    dimensions: string[];
    condition: "ALL" | "ANY";
    multiplier: number;
    upgradeLevel: boolean;
    label: string;
  }>,
): Promise<PreAuditReport> {
  const emit = (msg: string) => {
    try {
      sendProgress?.(msg);
    } catch {
      /* ignore */
    }
  };

  // Step 1: Strip context
  const stripped = stripContext(content);

  // Step 2: Bare-text audit (3 dimensions)
  emit("🧪 [1/4] 正在执行裸文维度审计（Step 2）...");
  const bareOnlyAuditors = systemAuditors.filter(
    (a) =>
      a.meta.id === "context_distortion" ||
      a.meta.id === "network_culture_risk" ||
      a.meta.id === "cross_lingual_distortion",
  );
  const bareFindings =
    bareOnlyAuditors.length > 0
      ? await runSystemAuditors(stripped.bare, bareOnlyAuditors, caller, undefined, localFindings, step0Result, webContextMap)
      : [];

  // Step 3: Full-text audit (all auditors)
  emit(`📊 [2/4] 正在并发执行全维度深度审计（Step 3，共 ${systemAuditors.length} 个维度）...`);
  const auditorResults = await runSystemAuditors(content, systemAuditors, caller, timingContext, localFindings, step0Result, webContextMap);

  // Step 4: Delta analysis
  const deltaRisks = computeDeltaAnalysis(bareFindings, auditorResults);

  // Step 5: Merge local findings
  const mergedResults = normalizePreAuditDimensions(
    mergeLocalFindingsIntoAudits(auditorResults, localFindings),
    systemAuditors,
  );

  // Step 6: Cross-validation
  emit("🔀 [3/4] 正在执行交叉验证（Step 6）...");
  const crossValidatedResults = await crossValidateRiskyDimensions(content, mergedResults, systemAuditors, caller);

  // Step 7: Synergy calculation
  const dimensionLevels: Record<string, string> = {};
  for (const dim of crossValidatedResults) {
    dimensionLevels[dim.id] = dim.level ?? "🟢";
  }
  const timingFlag = localFindings.some((f: any) => f.timingWindowId) ? ["timing_risk"] : [];
  const synergy = calculateSynergy(dimensionLevels, timingFlag, synergyRules);

  // Step 8: Final arbitration
  emit("⚖️ [4/4] 正在进行最终仲裁（Step 8）...");
  const report = await finalizePreAuditReport(
    content,
    localFindings,
    mergedResults,
    crossValidatedResults,
    systemAuditors,
    caller,
    synergy,
    deltaRisks,
    precedents,
    prompts,
  );

  report.synergyFlags = {
    triggered: synergy.triggered,
    overallMultiplier: synergy.overallMultiplier,
    levelUpgrades: synergy.levelUpgrades,
  };
  report.deltaRisks = deltaRisks;

  return report;
}

// ── Orchestration turn steps ──────────────────────────────────────────────────

export const orchestrationStep0: OrchestrationTurnStep = {
  id: "orchestration_step0",
  kind: "orchestration_turn",
  async buildPrompt(ctx: ReviewStepContext): Promise<string> {
    // This is used by the wizard to build the Turn 1 prompt
    // The actual prompt is built by the wizard using buildOrchestrationStep0Prompt
    return "";
  },
  async resume(ctx: ReviewStepContext, hostResult: unknown): Promise<ReviewStepResult> {
    const parsed = hostResult as Record<string, unknown>;
    const step0Result: Step0Result = {
      wildTranslations: (parsed.wildTranslations ?? []) as Step0Result["wildTranslations"],
      blackAtoms: (parsed.blackAtoms ?? []) as Step0Result["blackAtoms"],
      attackCandidates: (parsed.attackCandidates ?? []) as Step0Result["attackCandidates"],
      precedents: (parsed.precedents ?? []) as Precedent[],
    };

    const webContextMap: Record<string, string> = {};
    if (parsed.webContextMap && typeof parsed.webContextMap === "object" && !Array.isArray(parsed.webContextMap)) {
      for (const [key, value] of Object.entries(parsed.webContextMap as Record<string, unknown>)) {
        if (typeof value === "string") {
          webContextMap[key] = value;
        }
      }
    }

    return {
      stepId: "orchestration_step0",
      output: { step0Result, webContextMap },
    };
  },
};

export const orchestrationAudit: OrchestrationTurnStep = {
  id: "orchestration_audit",
  kind: "orchestration_turn",
  async buildPrompt(ctx: ReviewStepContext): Promise<string> {
    return "";
  },
  async resume(ctx: ReviewStepContext, hostResult: unknown): Promise<ReviewStepResult> {
    const parsed = hostResult as Record<string, unknown>;
    return {
      stepId: "orchestration_audit",
      output: {
        dimensions: parsed.dimensions ?? [],
        deltaRisks: parsed.deltaRisks ?? buildEmptyDeltaRisks(),
      },
    };
  },
};

export const orchestrationFinal: OrchestrationTurnStep = {
  id: "orchestration_final",
  kind: "orchestration_turn",
  async buildPrompt(ctx: ReviewStepContext): Promise<string> {
    return "";
  },
  async resume(ctx: ReviewStepContext, hostResult: unknown): Promise<ReviewStepResult> {
    const parsed = hostResult as Record<string, unknown>;
    return {
      stepId: "orchestration_final",
      output: {
        dimensions: parsed.dimensions ?? [],
        summary: parsed.summary ?? "",
        worstCaseNarrative: parsed.worstCaseNarrative ?? undefined,
        riskProfile: parsed.riskProfile ?? undefined,
        attackChainAnalysis: parsed.attackChainAnalysis ?? undefined,
      },
    };
  },
};
