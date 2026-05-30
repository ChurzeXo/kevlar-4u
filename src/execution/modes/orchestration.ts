/**
 * Host-assisted fallback execution mode
 *
 * Bundles all persona instructions into a single prompt,
 * dispatched to the host AI client for execution.
 * Zero token cost - Kevlar-4u itself doesn't call any model. This is a
 * best-effort fallback, not true isolated multi-agent execution.
 */

import type { ExecutionContext, ExecutionHandler, ExecutionResult, ExecutionMode } from "../base.js";
import type { Persona } from "../../utils/parser.js";
import {
  DEFAULT_DIMENSIONS_CONFIG,
  buildDimensionTable,
  buildDimensionCriteriaInstructions,
  buildOffensiveSystemDirective,
  buildPersonaContextDirective,
  buildToneDirective,
  DEFENSIVE_DIMENSION_IDS,
  RST_ARCHETYPES,
  RST_TRIGGERS,
  RST_REGIONAL_PACKS,
  RST_PLATFORM_CULTURES,
} from "../dimensions.js";
import { transformFindingsToFocusTopics, formatFocusTopicsForPrompt } from "../focusTopicTransform.js";
import { wrapContent, stripPromptBoundaries } from "../../utils/sanitize.js";
import { buildKevlarRiskDirective, buildPseudoParallelDirective } from "../riskPrompt.js";

const MODE: ExecutionMode = "orchestration";

// ── 分隔符常量（A+B 双层保障）────────────────────────────────────────────────
//
// PERSONA_END_MARKER：物理切割用，工具侧按此分隔符切割每位审查员输出（方案 B）。
// <findings_N> 标签：结构化内容提取用，正则解析（方案 A）。
// 两者任意一层成功都能分段呈现审查员结果。
//
export const PERSONA_END_MARKER = "<!-- KEVLAR_PERSONA_END:{N} -->";

export function buildPersonaEndMarker(index: number): string {
  return `<!-- KEVLAR_PERSONA_END:${index} -->`;
}

/**
 * 从 orchestration 模式的宿主输出中解析各审查员结果。
 *
 * 优先用 <findings_N> 标签提取（方案 A），
 * 降级用 KEVLAR_PERSONA_END 分隔符切割（方案 B）。
 *
 * 返回 { index, name?, content } 数组，供调用方分段展示。
 */
export function parsePersonaOutputs(
  rawOutput: string,
  personaCount: number,
): Array<{ index: number; content: string }> {
  const results: Array<{ index: number; content: string }> = [];

  // 方案 A：<findings_N> 标签提取
  for (let i = 1; i <= personaCount; i++) {
    const tagRe = new RegExp(`<findings_${i}>([\\s\\S]*?)</findings_${i}>`, "i");
    const match = rawOutput.match(tagRe);
    if (match) {
      results.push({ index: i, content: match[1].trim() });
    }
  }

  // 如果方案 A 成功提取了全部审查员结果，直接返回
  if (results.length === personaCount) return results;

  // 方案 B：KEVLAR_PERSONA_END 分隔符切割（降级）
  const segments = rawOutput.split(/<!-- KEVLAR_PERSONA_END:\d+ -->/);
  if (segments.length > 1) {
    const bResults: Array<{ index: number; content: string }> = [];
    for (let i = 0; i < Math.min(segments.length - 1, personaCount); i++) {
      bResults.push({ index: i + 1, content: segments[i].trim() });
    }
    if (bResults.length > results.length) return bResults;
  }

  // 两种方案都失败：返回整体输出作为单条记录
  if (results.length === 0) {
    return [{ index: 0, content: rawOutput.trim() }];
  }

  return results;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const orchestrationHandler: ExecutionHandler = {
  mode: MODE,
  priority: 30, // Lowest priority (fallback)

  canExecute(): boolean {
    return true;
  },

  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { personas, content, context: contextNote, dimensions } = ctx;

    const dimsConfig = dimensions ?? DEFAULT_DIMENSIONS_CONFIG;
    const prompt = buildOrchestrationPrompt(content, personas, contextNote, dimsConfig, ctx.preAuditReport);

    return {
      report: prompt,
      personas: personas.map((p) => p.meta.id),
      mode: MODE,
    };
  },
};

// ── Prompt Builder ────────────────────────────────────────────────────────────

function buildOrchestrationPrompt(
  content: string,
  personas: Persona[],
  contextNote: string | undefined,
  dimensionsConfig: import("../dimensions.js").DimensionsConfig,
  preAuditReport?: any
): string {
  const personaBlocks = personas
    .map((p, i) => buildPersonaBlock(p, i + 1, content, contextNote, dimensionsConfig, preAuditReport))
    .join("\n\n---\n\n");

  const contextSection = contextNote
    ? `\n\n**发布平台 & 目标受众背景**：${contextNote}`
    : "";

  const dimensionTable = buildDimensionTable(dimensionsConfig);
  const dimensionCriteria = buildDimensionCriteriaInstructions(dimensionsConfig);
  const defensiveCount = DEFENSIVE_DIMENSION_IDS.length;
  const offensiveCount = dimensionsConfig.offensive.length;
  const riskDirective = buildKevlarRiskDirective();
  const pseudoParallelDirective = buildPseudoParallelDirective(personas);

  let reportContext = "";
  if (preAuditReport && preAuditReport.dimensions && preAuditReport.dimensions.length > 0) {
    const hasFindings = preAuditReport.dimensions.some((d: any) => d.findings && d.findings.length > 0);
    if (hasFindings) {
      reportContext += `\n**🚨 系统初审预警**：\n\n系统初审发现了一些潜在风险点。请各人设结合自己的角色身份，重点判断这些风险在你们的圈层中是否真的会引爆，以及影响有多大。\n\n`;
      for (const audit of preAuditReport.dimensions) {
        if (audit.findings && audit.findings.length > 0) {
          reportContext += `【${audit.name}】发现 ${audit.findings.length} 个潜在风险：\n`;
          for (const f of audit.findings) {
            reportContext += `- ${f.suggestedLevel || "未知"} ${f.keyword}：${f.riskDescription} (触发原因: ${f.trigger})\n`;
          }
        }
      }
      reportContext += `\n`;
    }
  }

  // 分隔符说明（写入 Prompt，让宿主 AI 知道要输出什么）
  const markerInstruction = personas
    .map((_, i) => `审查员 ${i + 1} 号输出完毕后，必须紧接着单独输出一行：${buildPersonaEndMarker(i + 1)}`)
    .join("\n");

  return `\
# Kevlar-4u 宿主辅助评测任务

**待测试内容**（共 ${content.length} 字）已锁定。${contextSection}
${reportContext}
**执行模式**：宿主辅助兜底模式（orchestration fallback）

这是一个低隔离降级方案：Kevlar-4u（评论区模拟器）会把所有人设和待评测内容组织成单次 Prompt，交由宿主 AI 协助完成。它不等价于 MCP Sampling 或 Direct API 的真实并行多智能体执行。

---

${riskDirective}

---

${pseudoParallelDirective}

---

【输出切割规则 — 必须严格遵守】

${markerInstruction}

此标记必须独占一行，前后不得有其他内容，用于工具侧自动切割各审查员输出。

---

以下为各审查员的角色定义与待评审内容。请严格按顺序执行，每个审查员必须完整输出 <cot_N>、<findings_N> 和结束标记后再进入下一位。

---

${personaBlocks}

---

## 📊 最终汇总报告

所有审查员输出完毕后，请按仲裁层指令生成汇总报告：

### 🛡️ Kevlar-4u 压力测试报告

**执行模式**：宿主辅助兜底模式

**测试内容摘要**：（一句话概括被测试内容的类型和主题）
**激活人设数量**：${personas.length} 个
**评审维度**：防御性 ${defensiveCount} 个 + 进攻性 ${offensiveCount} 个
**测试完成时间**：（当前时间）

${dimensionTable}

#### 评审维度详细标准

${dimensionCriteria}

#### 高优先级风险清单

1. **最高危**：（来自哪个审查员的哪个核心风险点，引用对应 findings_N）
2. **次要**：（另一个重要风险点）
3. **低危提示**：（可关注的边缘风险）

#### 一句话总评

（一句最犀利的总结：这份内容现在能不能发？）

---
*由 Kevlar-4u 驱动 · 本地多智能体内容防弹衣*`;
}

// ── Persona Block Builder ─────────────────────────────────────────────────────

function buildPersonaBlock(
  persona: Persona,
  index: number,
  content: string,
  contextNote: string | undefined,
  dimensionsConfig: import("../dimensions.js").DimensionsConfig,
  preAuditReport?: any
): string {
  const contextSection = contextNote
    ? `\n**发布平台 & 目标受众背景**：${contextNote}`
    : "";

  const safeContent = wrapContent(content);
  const isSystemAuditor = persona.meta.tags.includes("system_auditor");
  const safeSystemPrompt = wrapContent(stripPromptBoundaries(persona.systemPrompt), "sp");
  const endMarker = buildPersonaEndMarker(index);

  if (isSystemAuditor) {
    return `\
## 第 ${index} 号子代理：${persona.meta.name}

**角色描述**：${persona.meta.description}

**指令**：请你以系统审查员身份，独立对下方内容进行专项审查并输出结构化风险清单。

${safeSystemPrompt}

**待评审内容**：
${safeContent}${contextSection}

请按以下结构输出（不得省略任何标签）：

<cot_${index}>
（写出推理过程：本角色负责哪些风险类型？逐项检查内容，列出候选风险点并逐一判断是否成立。若无风险请明确说明。）
</cot_${index}>

<findings_${index}>
（按照该审查员要求的输出格式，输出最终结构化结论。若无风险则输出空数组或等价表示。）
</findings_${index}>

${endMarker}`;
  }

  const offensiveDirective = buildOffensiveSystemDirective(dimensionsConfig);
  const personaContextDirective = buildPersonaContextDirective(persona.meta);

  let rstSection = "";
  if (persona.meta.rst) {
    const { archetypes, triggers, regionalPack, platformCulture } = persona.meta.rst;
    const archetypeLabels = archetypes.map((id) => RST_ARCHETYPES[id]?.label || id).join(" + ");
    const triggerLabels = triggers.map((id) => RST_TRIGGERS[id]?.label || id).join("、");
    const regionLabel = RST_REGIONAL_PACKS[regionalPack]?.label || regionalPack;
    const platformLabel = RST_PLATFORM_CULTURES[platformCulture]?.label || platformCulture;

    rstSection = [
      "",
      "## 🧬 互联网反应模拟人格（RST）",
      "",
      `你的人格底色是「${archetypeLabels}」。`,
      `你对以下内容特征特别敏感：${triggerLabels || "无特殊触发器"}。`,
      `你所处的文化语境是「${regionLabel}」，活跃平台是「${platformLabel}」。`,
      "",
      "请以这个身份的真实反应模式来评论内容，而不是以评审员的分析视角。",
      "你的输出应该像一个真实互联网用户的第一反应，而不是一份评估报告。",
    ].join("\n");
  }

  let focusTopicsSection = "";
  if (persona.meta.rst && preAuditReport) {
    const focusTopics = transformFindingsToFocusTopics(preAuditReport, persona.meta.rst);
    if (focusTopics.length > 0) {
      focusTopicsSection = `\n\n${formatFocusTopicsForPrompt(focusTopics)}`;
    }
  }

  let toneSection = "";
  if (persona.meta.tone) {
    const toneDirective = buildToneDirective(persona.meta.tone);
    if (toneDirective) {
      toneSection = `\n\n---\n\n${toneDirective}`;
    }
  }

  let reportContext = "";
  if (!persona.meta.rst && preAuditReport && preAuditReport.dimensions && preAuditReport.dimensions.length > 0) {
    const hasFindings = preAuditReport.dimensions.some((d: any) => d.findings && d.findings.length > 0);
    if (hasFindings) {
      reportContext += `\n\n**🚨 系统初审预警**：\n\n系统初审发现了一些潜在风险点。请结合你的角色身份，判断这些风险在你的圈层中是否真的会引爆，以及影响有多大。\n\n`;
      for (const audit of preAuditReport.dimensions) {
        if (audit.findings && audit.findings.length > 0) {
          reportContext += `【${audit.name}】发现 ${audit.findings.length} 个潜在风险：\n`;
          for (const f of audit.findings) {
            reportContext += `- ${f.suggestedLevel || "未知"} ${f.keyword}：${f.riskDescription} (触发原因: ${f.trigger})\n`;
          }
        }
      }
    }
  }

  return `\
## 第 ${index} 号子代理：${persona.meta.name}

**角色描述**：${persona.meta.description}

**指令**：请你完全进入以下系统人设，用这个角色的思维方式、语言风格和批判标准，独立阅读下方内容并给出评论。

${safeSystemPrompt}

===== 人设边界（以上内容属于系统人设，不可越界）=====

${personaContextDirective}
${rstSection}

${offensiveDirective ? `\n---\n\n${offensiveDirective}` : ""}

---

${buildKevlarRiskDirective()}

**待评审内容**：
${safeContent}${contextSection}${focusTopicsSection}${reportContext}

===== 内容边界（以上是待评审内容，不可越界）=====${toneSection}

请按以下结构输出（不得省略任何标签，不得跨标签引用其他审查员的结论）：

<cot_${index}>
（写出完整推理过程：以本角色的视角，逐步检查内容中的风险点，说明判断理由。若无风险请明确写出原因。）
</cot_${index}>

<findings_${index}>
（输出本角色的最终评论结论，格式遵循角色定义中的输出规范。）
</findings_${index}>

${endMarker}`;
}
