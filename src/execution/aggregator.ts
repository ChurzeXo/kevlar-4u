/**
 * Result Aggregator for Multi-Agent Execution
 * 
 * Combines results from multiple personas into a unified report.
 */

import type { ExecutionMode } from "./base.js";
import type { DimensionsConfig } from "./dimensions.js";
import { DEFAULT_DIMENSIONS_CONFIG, buildDimensionTable, buildDimensionCriteriaInstructions } from "./dimensions.js";

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
}

export function generateAggregatedReport(options: AggregatedReportOptions): string {
  const { mode, contentSummary, personas, dimensions } = options;
  const dimsConfig = dimensions ?? DEFAULT_DIMENSIONS_CONFIG;
  const successful = personas.filter((p) => !p.error);
  const failed = personas.filter((p) => p.error);

  const modeLabels: Record<ExecutionMode, string> = {
    orchestration: "宿主辅助兜底模式",
    mcp_sampling: "MCP 采样模式",
    direct_api: "直接 API 模式",
  };

  let report = `## 🛡️ Kevlar-4u 压力测试报告

**执行模式**：${modeLabels[mode]}
**测试内容摘要**：${contentSummary}
**参与评审员**：${successful.map((p) => p.personaName).join("、")}（共 ${successful.length} 位）`;

  if (failed.length > 0) {
    report += `\n**部分失败**：${failed.map((p) => `${p.personaName}（${p.error}）`).join("、")}`;
  }

  report += `\n**测试完成时间**：${new Date().toLocaleString("zh-CN")}`;

  // Individual reviews
  if (successful.length > 0) {
    report += "\n\n---\n\n## 各评审员观点\n";
    for (const p of successful) {
      report += `\n### ${p.personaName}\n\n${p.review}\n`;
    }
  }

  // Aggregated review summary
  report += `

---

## 综合维度评估

${buildDimensionTable(dimsConfig)}

---

## 综合摘要

${resultsSummary(successful)}`;

  report += `

---

*由 Kevlar-4u 驱动 · 本地多智能体内容防弹衣*`;

  return report;
}

function resultsSummary(successful: PersonaResultWithMeta[]): string {
  if (successful.length === 0) return "无评审员成功完成评测。";

  const lines: string[] = [];
  for (const p of successful) {
    const firstLine = p.review.split("\n")[0]?.replace(/^[#*\s]+/, "").slice(0, 80) || "";
    lines.push(`- **${p.personaName}**：${firstLine}${firstLine.length >= 80 ? "…" : ""}`);
  }
  return lines.join("\n");
}

// ── Token Budget ──────────────────────────────────────────────────────────────

const DEFAULT_TOKEN_BUDGET = {
  per_task: 50_000,
  per_persona: 10_000,
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
