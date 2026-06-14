/**
 * Result Aggregator for Multi-Agent Execution
 * 
 * Combines results from multiple personas into a unified report.
 */

import type { ExecutionMode } from "./base.js";
import type { DimensionsConfig } from "./dimensions.js";
import { DEFAULT_DIMENSIONS_CONFIG, buildDimensionTable, buildDimensionCriteriaInstructions } from "./dimensions.js";
import { t, getCurrentLanguage } from "../i18n/index.js";
import { getModeLabel } from "../i18n/tools-i18n.js";
import { isPro } from "../subscription/tier.js";
import { DEFAULT_FREE_PROMPTS, type PromptSegments } from "../subscription/promptTypes.js";

// ── Persona Result ────────────────────────────────────────────────────────────

interface PersonaResult {
  personaId: string;
  personaName: string;
  review: string;
  error?: string;
}

interface PersonaResultWithMeta extends PersonaResult {
  completedAt: Date;
}

// ── Partial Result Container ───────────────────────────────────────────────────

interface PartialResult<T> {
  successful: T[];
  failed: Array<{ index: number; error: string }>;
  successRate: number;
}

// ── Aggregator ────────────────────────────────────────────────────────────────

export class ResultAggregator {
  private results: PersonaResultWithMeta[] = [];
  private failedCount = 0;

  addSuccess(result: PersonaResult): void {
    this.results.push({
      ...result,
      completedAt: new Date(),
    });
  }

  addFailure(personaId: string, personaName: string, error: string): void {
    this.failedCount++;
    this.results.push({
      personaId,
      personaName,
      review: "",
      error,
      completedAt: new Date(),
    });
  }

  getResults(): PersonaResultWithMeta[] {
    return [...this.results];
  }

  getSuccessful(): PersonaResultWithMeta[] {
    return this.results.filter((r) => !r.error);
  }

  getFailed(): PersonaResultWithMeta[] {
    return this.results.filter((r) => r.error);
  }

  getPartialResult(): PartialResult<PersonaResultWithMeta> {
    const total = this.results.length;
    const successRate = total > 0 ? (total - this.failedCount) / total : 0;
    
    return {
      successful: this.getSuccessful(),
      failed: this.getFailed().map((r, i) => ({
        index: i,
        error: r.error || "Unknown error",
      })),
      successRate,
    };
  }
}

// ── Report Generator ─────────────────────────────────────────────────────────

interface AggregatedReportOptions {
  mode: ExecutionMode;
  contentSummary: string;
  personas: PersonaResultWithMeta[];
  dimensions?: DimensionsConfig;
  preAuditReport?: any;
  prompts?: PromptSegments;
}

export function generateAggregatedReport(options: AggregatedReportOptions): string {
  const { mode, contentSummary, personas, dimensions } = options;
  const dimsConfig = dimensions ?? DEFAULT_DIMENSIONS_CONFIG;
  const successful = personas.filter((p) => !p.error);
  const failed = personas.filter((p) => p.error);

  const modeLabel = getModeLabel(mode);
  const locale = getCurrentLanguage();
  const joinChar = locale === "zh-CN" ? "、" : ", ";

  let report = `## 🛡️ Kevlar-4u ${t("report.title", { ns: "common", defaultValue: "Stress Test Report" })}

**${t("report.executionMode", { ns: "common", defaultValue: "Execution Mode" })}**：${modeLabel}
**${t("report.contentSummary", { ns: "common", defaultValue: "Content Summary" })}**：${contentSummary}
**${t("report.reviewers", { ns: "common", defaultValue: "Reviewers" })}**：${successful.map((p) => p.personaName).join(joinChar)}（${t("report.total", { ns: "common", defaultValue: "Total", count: successful.length })}）`;

  if (failed.length > 0) {
    report += `\n**${t("report.partialFailure", { ns: "common", defaultValue: "Partial Failure" })}**：${failed.map((p) => `${p.personaName}（${p.error}）`).join(joinChar)}`;
  }

  const dateLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  report += `\n**${t("report.completedAt", { ns: "common", defaultValue: "Completed At" })}**：${new Date().toLocaleString(dateLocale)}`;

  if (options.preAuditReport && options.preAuditReport.dimensions && options.preAuditReport.dimensions.length > 0) {
    const hasFindings = options.preAuditReport.dimensions.some((d: any) => d.findings && d.findings.length > 0);
    if (hasFindings) {
      report += `\n\n---\n\n## 🚨 ${t("report.systemFindings", { ns: "common", defaultValue: "System Initial Findings" })}\n\n`;
      report += `${t("report.systemFindingsDesc", { ns: "common", defaultValue: "The system initial review scanned the following potential risk points:" })}\n`;
      for (const audit of options.preAuditReport.dimensions) {
        if (audit.findings && audit.findings.length > 0) {
          report += `\n### 【${audit.name}】${t("report.foundRisks", { ns: "common", defaultValue: "Found {{count}} risk items", count: audit.findings.length })}\n`;
          for (const f of audit.findings) {
            report += `- **${f.suggestedLevel || t("report.unknown", { ns: "common", defaultValue: "Unknown" })} ${f.keyword}**\n`;
            report += `  - ${t("report.triggerReason", { ns: "common", defaultValue: "Trigger Reason" })}：${f.trigger}\n`;
            report += `  - ${t("report.riskDescription", { ns: "common", defaultValue: "Risk Description" })}：${f.riskDescription}\n`;
          }
        }
      }
    }
    if (options.preAuditReport.precedents && options.preAuditReport.precedents.length > 0) {
      const segs = options.prompts ?? DEFAULT_FREE_PROMPTS;
      report += `\n\n### 📌 ${t("report.precedents", { ns: "common", defaultValue: "Similar Precedents (for reference)" })}\n\n`;
      if (isPro()) {
        for (const p of options.preAuditReport.precedents) {
          report += `- ${p.event}${p.date ? `（${p.date}）` : ""}\n`;
        }
      } else {
        const lockText = locale === "zh-CN" ? segs.precedentLockedCn : segs.precedentLockedEn;
        report += `${lockText}\n`;
      }
    }
  }

  // Individual reviews
  if (successful.length > 0) {
    report += `\n\n---\n\n## ${t("report.reviewerOpinions", { ns: "common", defaultValue: "Reviewer Opinions" })}\n`;
    for (const p of successful) {
      report += `\n### ${p.personaName}\n\n${p.review}\n`;
    }
  }

  // Aggregated review summary
  report += `

---

## ${t("report.dimensionAssessment", { ns: "common", defaultValue: "Dimension Assessment" })}

${buildDimensionTable(dimsConfig)}

---

## ${t("report.summary", { ns: "common", defaultValue: "Summary" })}

${resultsSummary(successful)}`;

  report += `

---

*${t("report.poweredBy", { ns: "common", defaultValue: "Powered by Kevlar-4u · Local Multi-Agent Content Armor" })}*`;

  return report;
}

function resultsSummary(successful: PersonaResultWithMeta[]): string {
  if (successful.length === 0) return t("report.noReviewers", { ns: "common", defaultValue: "No reviewers successfully completed the review." });

  const locale = getCurrentLanguage();
  const colon = locale === "zh-CN" ? "：" : ": ";
  const ellipsis = locale === "zh-CN" ? "…" : "...";

  const lines: string[] = [];
  for (const p of successful) {
    const firstLine = p.review.split("\n")[0]?.replace(/^[#*\s]+/, "").slice(0, 80) || "";
    lines.push(`- **${p.personaName}**${colon}${firstLine}${firstLine.length >= 80 ? ellipsis : ""}`);
  }
  return lines.join("\n");
}

// ── Token Budget ──────────────────────────────────────────────────────────────

const DEFAULT_TOKEN_BUDGET = {
  per_task: 100_000,
  per_persona: 15_000,
};

export function estimateTokenCost(
  personas: number,
  contentLength: number,
  content?: string,
  personaSystemPrompts?: string[]
): number {
  let cjkRatio = 0.5;
  if (content) {
    const sample = content.slice(0, 200);
    let cjkCount = 0;
    for (const ch of sample) {
      if (ch >= '\u4e00' && ch <= '\u9fff') cjkCount++;
    }
    cjkRatio = cjkCount / Math.max(sample.length, 1);
  }
  const charsPerToken = 4 - cjkRatio * 2;
  const contentTokens = Math.floor(contentLength / Math.max(charsPerToken, 1));

  let systemPromptTokens = 0;
  if (personaSystemPrompts) {
    for (const sp of personaSystemPrompts) {
      systemPromptTokens += Math.floor(sp.length / Math.max(charsPerToken, 1));
    }
  }

  return contentTokens + personas * DEFAULT_TOKEN_BUDGET.per_persona + systemPromptTokens;
}

export function checkBudget(personas: number, contentLength: number, personaSystemPrompts?: string[]): void {
  const budget =
    Number(process.env.KEVLAR_TOKEN_BUDGET_PER_TASK) || DEFAULT_TOKEN_BUDGET.per_task;
  const estimated = estimateTokenCost(personas, contentLength, undefined, personaSystemPrompts);

  if (estimated > budget) {
    throw new Error(
      `预估 Token 消耗 (${estimated}) 超出预算 (${budget})。` +
        `请减少评审员数量或缩短内容长度。`
    );
  }
}
