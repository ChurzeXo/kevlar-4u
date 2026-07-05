/**
 * Structured subagent dispatch execution mode.
 *
 * Dispatches persona audit tasks to the Host AI as isolated parallel
 * execution contexts via ExecutionBlueprint (kevlar.blueprint/v1).
 * True isolation + true parallelism — zero token cost for Kevlar.
 *
 * This is the preferred mode when MCP Sampling is unavailable but the
 * Host AI supports native subagent/task creation tools.
 */

import type { ExecutionContext, ExecutionHandler, ExecutionResult, ExecutionMode } from "../base.js";
import type { Persona } from "../../utils/parser.js";
import { isSubagentDispatchSupported } from "../client.js";
import { DEFAULT_DIMENSIONS_CONFIG, DEFENSIVE_DIMENSION_IDS } from "../dimensions.js";
import { buildCoreReasoningFramework, buildCoreFrameworkSteps, buildCommonRiskRules, buildCompactAuditorCoT } from "../../prompts/reviewWizard.js";
import { buildOffensiveSystemDirective, buildPersonaContextDirective, buildToneDirective, buildDimensionTable, buildDimensionCriteriaInstructions } from "../dimensions.js";
import { buildKevlarRiskDirective, buildPseudoParallelDirective } from "../riskPrompt.js";
import { wrapContent, sanitizeForBoundary } from "../../utils/sanitize.js";

const MODE: ExecutionMode = "mcp_subagent";

export const subagentHandler: ExecutionHandler = {
  mode: MODE,
  priority: 15, // Between sampling (10) and orchestration (30)

  canExecute(): boolean {
    return isSubagentDispatchSupported();
  },

  getReason(): string {
    return "宿主 AI 不支持 Subagent 并行调度，将使用编排模式";
  },

  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { personas, content, context: contextNote, dimensions } = ctx;

    const dimsConfig = dimensions ?? DEFAULT_DIMENSIONS_CONFIG;
    const prompt = buildStructuredDispatchPrompt(content, personas, contextNote, dimsConfig);

    return {
      report: prompt,
      personas: personas.map((p) => p.meta.id),
      mode: MODE,
    };
  },
};

// ── Structured Dispatch Prompt Builder ────────────────────────────────────────

function buildStructuredDispatchPrompt(
  content: string,
  personas: Persona[],
  contextNote: string | undefined,
  dimensionsConfig: import("../dimensions.js").DimensionsConfig,
): string {
  const contextSection = contextNote
    ? `\n\n**发布平台 & 目标受众背景**：${contextNote}`
    : "";

  const defensiveCount = DEFENSIVE_DIMENSION_IDS.length;
  const offensiveCount = dimensionsConfig.offensive.length;
  const riskDirective = buildKevlarRiskDirective();
  const pseudoParallelDirective = buildPseudoParallelDirective(personas);

  // Build per-persona context instructions for isolated execution
  const contextInstructions = personas.map((p, i) => {
    const safeContent = wrapContent(sanitizeForBoundary(content));
    const dimensionTable = buildDimensionTable(dimensionsConfig);
    const dimensionCriteria = buildDimensionCriteriaInstructions(dimensionsConfig);

    const coreFramework = buildCoreReasoningFramework();
    const commonRules = buildCommonRiskRules();
    const coreSteps = buildCoreFrameworkSteps();
    const compactCoT = buildCompactAuditorCoT(p);

    const offensiveDirective = buildOffensiveSystemDirective(dimensionsConfig);
    const personaContextDirective = buildPersonaContextDirective(p.meta);

    let toneSection = "";
    if (p.meta.tone) {
      const toneDirective = buildToneDirective(p.meta.tone);
      if (toneDirective) toneSection = `\n\n---\n\n${toneDirective}`;
    }

    return {
      id: p.meta.id,
      role: p.meta.tags.includes("system_auditor") ? "safety_reviewer" : "persona_reviewer",
      instructions: [
        `## Context: ${p.meta.name}`,
        `**Role**: ${p.meta.description}`,
        "",
        coreFramework,
        commonRules,
        "",
        `**System Directive**: ${p.systemPrompt}`,
        "",
        personaContextDirective,
        offensiveDirective ? `\n---\n\n${offensiveDirective}` : "",
        compactCoT ? `\n\n## Reasoning Method\n\n${coreSteps}\n\n${compactCoT}` : "",
        `\n\n**Content to audit**:\n${safeContent}${contextSection}`,
        toneSection,
      ].filter(Boolean).join("\n"),
      input: { contentRef: "content" },
      outputSchema: "kevlar.reviewer/v1",
    };
  });

  // Build a standalone dispatch prompt that the Host AI can use directly
  return [
    `# Kevlar-4u Structured Subagent Dispatch`,
    "",
    `**Content** (${content.length} chars) locked.${contextSection}`,
    `**Mode**: mcp_subagent — structured parallel execution`,
    "",
    `This is a structured execution request. You should create ${personas.length} independent`,
    `execution contexts, one per persona below. Each context's instructions are`,
    `self-contained and require no shared state.`,
    "",
    `---`,
    "",
    riskDirective,
    "",
    `---`,
    "",
    pseudoParallelDirective,
    "",
    `---`,
    "",
    `## Execution Contexts (${personas.length} total)`,
    "",
    ...contextInstructions.map((ctx, i) => [
      `### Context ${i + 1}: \`${ctx.id}\` (${ctx.role})`,
      "",
      "```",
      `ID: ${ctx.id}`,
      `Role: ${ctx.role}`,
      `Output Schema: ${ctx.outputSchema}`,
      "```",
      "",
      "**Instructions:**",
      ctx.instructions,
      "",
      "---",
    ].join("\n")),
    "",
    `## Aggregation`,
    "",
    `After all ${personas.length} contexts complete, aggregate results into a single`,
    `report with one entry per persona, preserving each persona's findings verbatim.`,
    "",
    `Do NOT fabricate or merge findings across personas. Report truthfully if any`,
    `context failed to execute.`,
  ].join("\n");
}
