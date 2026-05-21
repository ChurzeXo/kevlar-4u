/**
 * Result Aggregator for Multi-Agent Execution
 * 
 * Combines results from multiple personas into a unified report.
 */

import type { ExecutionMode } from "./base.js";

// ── Persona Result ────────────────────────────────────────────────────────────

export interface PersonaResult {
  personaId: string;
  personaName: string;
  review: string;
  error?: string;
}

export interface PersonaResultWithMeta extends PersonaResult {
  completedAt: Date;
}

// ── Partial Result Container ───────────────────────────────────────────────────

export interface PartialResult<T> {
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

export interface AggregatedReportOptions {
  mode: ExecutionMode;
  contentSummary: string;
  personas: PersonaResultWithMeta[];
}

export function generateAggregatedReport(options: AggregatedReportOptions): string {
  const { mode, contentSummary, personas } = options;
  
  const successful = personas.filter((p) => !p.error);
  const failed = personas.filter((p) => p.error);

  const modeLabels: Record<ExecutionMode, string> = {
    orchestration: "宿主辅助兜底模式",
    mcp_sampling: "MCP 采样模式",
    direct_api: "直接 API 模式",
  };

  let report = `## 🛡️ Kevlar 压力测试报告

**执行模式**：${modeLabels[mode]}
**测试内容摘要**：${contentSummary}
**参与评论员**：${successful.map((p) => p.personaName).join("、")}（共 ${successful.length} 位）`;

  if (failed.length > 0) {
    report += `\n**部分失败**：${failed.map((p) => `${p.personaName}（${p.error}）`).join("、")}`;
  }

  report += `\n**测试完成时间**：${new Date().toLocaleString("zh-CN")}`;

  // Individual reviews
  if (successful.length > 0) {
    report += "\n\n---\n\n## 各评论员观点\n";
    for (const p of successful) {
      report += `\n### ${p.personaName}\n\n${p.review}\n`;
    }
  }

  // Risk assessment template
  report += `

---

## 综合风险评估

| 维度 | 风险等级 | 说明 |
|------|---------|------|
| 逻辑严密性 | 🟢/🟡/🔴 | （说明） |
| 前段留存率 | 🟢/🟡/🔴 | （说明） |
| 传播潜力 | 🟢/🟡/🔴 | （说明） |
| 整体可信度 | 🟢/🟡/🔴 | （说明） |

## 高优先级修改建议

1. **最紧急**：（来自哪个人设的哪个核心槽点）
2. **次要**：（另一个重要建议）
3. **锦上添花**：（可选优化点）

## 一句话总评

（一句最犀利的总结：这份内容现在能不能发？）

---
*由 Kevlar MCP Server 驱动 · 本地多智能体内容防弹衣*`;

  return report;
}

// ── Token Budget ──────────────────────────────────────────────────────────────

export const DEFAULT_TOKEN_BUDGET = {
  per_task: 50_000,
  per_persona: 10_000,
};

export function estimateTokenCost(personas: number, contentLength: number, content?: string): number {
  // Estimate: CJK ~1-2 chars/token, English ~4 chars/token.
  // Use content sampling to pick a ratio that avoids over- or underestimation.
  let cjkRatio = 0.5; // default: mixed content (3 chars/token equivalent)
  if (content) {
    const sample = content.slice(0, 200);
    let cjkCount = 0;
    for (const ch of sample) {
      if (ch >= '\u4e00' && ch <= '\u9fff') cjkCount++;
    }
    cjkRatio = cjkCount / Math.max(sample.length, 1);
  }
  // Linear interpolation: pure CJK ~2 chars/tok, pure ASCII ~4 chars/tok, mixed → blend
  const charsPerToken = 4 - cjkRatio * 2; // 4 when 0% CJK, 2 when 100% CJK
  return Math.floor(contentLength / Math.max(charsPerToken, 1)) + personas * DEFAULT_TOKEN_BUDGET.per_persona;
}

export function checkBudget(personas: number, contentLength: number): void {
  const budget =
    Number(process.env.KEVLAR_TOKEN_BUDGET_PER_TASK) || DEFAULT_TOKEN_BUDGET.per_task;
  const estimated = estimateTokenCost(personas, contentLength);

  if (estimated > budget) {
    throw new Error(
      `预估 Token 消耗 (${estimated}) 超出预算 (${budget})。` +
        `请减少评论员数量或缩短内容长度。`
    );
  }
}
