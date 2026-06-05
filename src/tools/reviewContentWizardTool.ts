import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import { MultiTurnSamplingFunction } from "../execution/base.js";
import { loadAllPersonas, Persona } from "../utils/parser.js";
import { handleReviewContent } from "./reviewTool.js";
import { DEFAULT_DIMENSIONS_CONFIG, DEFENSIVE_DIMENSION_IDS, type DimensionsConfig } from "../execution/dimensions.js";
import { recommendRSTPersonas } from "../execution/rstRecommender.js";
import { logger, getErrorInfo } from "../utils/observability.js";
import type { ToolModule } from "./types.js";
import { LocalJsonRuleRepository } from "../dao/LocalJsonRuleRepository.js";
import { buildKevlarRiskDirective } from "../execution/riskPrompt.js";
import { callConfiguredDirectApi, hasApiKey } from "../execution/modes/direct_api.js";
import { calculateSynergy } from "../execution/synergyCalculator.js";
import { stripContext } from "../utils/stripContext.js";
import {
  TOOL_DESCRIPTION,
  buildOrchestrationPrompt,
  buildPreAuditFinalizerPrompt,
  buildCompactAuditorCoT,
} from "../prompts/reviewWizard.js";

export const reviewContentWizardToolDefinition: Tool = {
  name: "review_content_wizard",
  description: TOOL_DESCRIPTION,

  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "会话ID。首次调用时留空（工具会自动生成并返回）。后续调用必须传入相同 sessionId 以维持会话状态。",
      },
      userMessage: {
        type: "string",
        description:
          "用户当前输入内容。首次调用时传入待评测的完整文本或评测请求；后续交互时传入用户指令（如「开始复审」或「2 换一位」）。必须为纯文本。",
      },
    },
    required: ["userMessage"],
  },
};

export interface ReviewWizardInput {
  sessionId?: string;
  userMessage: string;
  samplingFn?: MultiTurnSamplingFunction;
}

type ReviewWizardStep =
  | "systemAudit"
  | "waitingForOrchestrationAudit"
  | "checkPersonaInventory"
  | "waitingForPersonaCreation"
  | "waitingForReviewDecision" // 新增：初审完成后等待用户决定是否复审
  | "waitingForReviewerConfirmation"
  | "completed";

interface ReviewWizardState {
  sessionId: string;
  createdAt: number;
  step: ReviewWizardStep;
  content: string;
  context?: string;
  targetPlatforms: string[];
  selectedPersonaIds: string[];
  remainingPersonaIds: string[];
  systemAuditorIds: string[];
  dimensions: DimensionsConfig;
  preAuditReport?: any;
}

interface Recommendation {
  personaIds: string[];
  assistantMessage: string;
}

export const reviewContentWizardModule: ToolModule = {
  definition: reviewContentWizardToolDefinition,
  handler: (deps) => async (args) => {
    if (!args) throw new Error("向导需要提供参数");
    const input = args as any;
    input.samplingFn = deps.resolveSamplingFn();
    return await handleReviewContentWizard(deps.skillsDir, deps.tmpDir, input);
  },
};

export async function handleReviewContentWizard(
  skillsDir: string,
  tmpDir: string,
  input: ReviewWizardInput,
): Promise<ToolResult> {
  if (!input.userMessage || typeof input.userMessage !== "string") {
    return {
      content: [{ type: "text", text: "❌ 请提供当前步骤的用户回复。" }],
      isError: true,
    };
  }

  try {
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const state = await loadOrCreateState(tmpDir, input);
    const allPersonas = await loadAllPersonas(skillsDir);
    const userPersonas = allPersonas.filter((p) => !p.meta.tags.includes("system_auditor"));
    const systemAuditors = allPersonas.filter((p) => p.meta.tags.includes("system_auditor"));
    return await advanceWizard(
      skillsDir,
      tmpDir,
      state,
      userPersonas,
      systemAuditors,
      input.userMessage,
      input.samplingFn,
    );
  } catch (err) {
    const info = getErrorInfo(err);
    logger.error("Review content wizard failed", {
      event: "review_wizard_error",
      error: info.code,
      message: info.message,
    });
    return {
      content: [{ type: "text", text: `❌ 内容评测向导失败：${info.message}` }],
      isError: true,
    };
  }
}

async function advanceWizard(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[], // user personas
  systemAuditors: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  switch (state.step) {
    case "systemAudit":
      return handleSystemAudit(skillsDir, tmpDir, state, personas, systemAuditors, samplingFn);

    case "waitingForOrchestrationAudit":
      return handleOrchestrationAuditResult(tmpDir, state, personas, userMessage, samplingFn);

    case "checkPersonaInventory":
      return handleInventoryCheck(tmpDir, state, personas, samplingFn);

    case "waitingForPersonaCreation":
      return handleInventoryCheck(tmpDir, state, personas, samplingFn);

    case "waitingForReviewDecision":
      return handleReviewDecision(skillsDir, tmpDir, state, personas, userMessage, samplingFn);

    case "waitingForReviewerConfirmation":
      return handleReviewerConfirmation(skillsDir, tmpDir, state, personas, userMessage, samplingFn);

    case "completed":
      return toolResponse(state, "这个评测流程已经完成。需要评测新内容时，请重新开始一个会话。");

    default:
      return toolResponse(state, "未知步骤，请重新开始评测流程。");
  }
}

type AuditLlmCaller = (params: {
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
}) => Promise<{ content: string; stopReason?: string }>;

async function handleSystemAudit(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  userPersonas: Persona[],
  systemAuditors: Persona[],
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  const localFindings = await buildLocalRuleFindings(skillsDir, state.content);

  if (systemAuditors.length === 0) {
    const dimensions =
      localFindings.length > 0
        ? [
            {
              id: "local_rule_engine",
              name: "本地规则引擎",
              findings: localFindings,
              level: getFindingsLevel(localFindings),
            },
          ]
        : [];
    state.preAuditReport = {
      dimensions,
      summary:
        dimensions.length > 0 ? summarizePreAuditResults(dimensions) : "未找到系统审查员，且本地规则未命中风险点",
    };
    state.step = "checkPersonaInventory";
    await saveState(tmpDir, state);
    return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
  }

  const caller = resolveSystemAuditCaller(samplingFn);
  if (!caller) {
    if (process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK === "1") {
      const results = normalizePreAuditDimensions(
        mergeLocalFindingsIntoAudits(
          systemAuditors.map((auditor) => ({
            id: auditor.meta.id,
            name: auditor.meta.name,
            findings: [],
            level: "🟢",
          })),
          localFindings,
        ),
        systemAuditors,
      );
      state.preAuditReport = { dimensions: results, summary: summarizePreAuditResults(results) };
      state.systemAuditorIds = systemAuditors.map((a) => a.meta.id);
      state.step = "checkPersonaInventory";
      await saveState(tmpDir, state);
      return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
    }

    state.step = "waitingForOrchestrationAudit";
    await saveState(tmpDir, state);
    return toolResponse(state, buildOrchestrationPrompt(state.content, systemAuditors));
  }

  try {
    // 从 localFindings 中提取时机上下文，注入给 social_risk LLM 审计员
    const timingFinding = localFindings.find((f) => f.timingDescription);
    const timingContext = timingFinding?.timingDescription as string | undefined;

    const preAuditReport = await executeLlmSystemAudit(
      state.content,
      systemAuditors,
      localFindings,
      caller,
      timingContext,
    );
    state.preAuditReport = preAuditReport;
    state.systemAuditorIds = systemAuditors.map((a) => a.meta.id);
    state.step = "checkPersonaInventory";
    await saveState(tmpDir, state);
    return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
  } catch (err) {
    logger.warn("LLM system audit failed, falling back to host orchestration", {
      event: "system_audit_llm_failed",
      error: getErrorInfo(err).message,
    });
    state.step = "waitingForOrchestrationAudit";
    await saveState(tmpDir, state);
    return toolResponse(state, buildOrchestrationPrompt(state.content, systemAuditors));
  }
}

function resolveSystemAuditCaller(samplingFn?: MultiTurnSamplingFunction): AuditLlmCaller | undefined {
  if (samplingFn) return samplingFn;
  if (!hasApiKey()) return undefined;
  return async (params) => {
    const response = await callConfiguredDirectApi({
      model: process.env.KEVLAR_MODEL || "",
      system: params.systemPrompt,
      messages: params.messages.map((message) => ({ role: "user", content: message.content })),
      maxTokens: params.maxTokens,
      temperature: 0.2,
    });
    return { content: response.content, stopReason: response.stopReason };
  };
}

async function executeLlmSystemAudit(
  content: string,
  systemAuditors: Persona[],
  localFindings: any[],
  caller: AuditLlmCaller,
  timingContext?: string,
): Promise<PreAuditReport> {
  // Phase 0.4: 物理脱嵌预处理 — 两轮投喂
  const stripped = stripContext(content);

  // Round 1: 裸文 → 仅 context_distortion + network_culture_risk 执行
  const bareOnlyAuditors = systemAuditors.filter(
    (a) => a.meta.id === "context_distortion" || a.meta.id === "network_culture_risk",
  );
  const bareFindings =
    bareOnlyAuditors.length > 0 ? await runSystemAuditors(stripped.bare, bareOnlyAuditors, caller) : [];

  // Round 2: 原文 → 所有维度执行（现有流程）
  const auditorResults = await runSystemAuditors(content, systemAuditors, caller, timingContext);

  // Delta 分析：bareFindings 有但 fullFindings 没有 → 脱嵌型风险
  const bareKeywords = new Set(bareFindings.flatMap((r) => r.findings.map((f: any) => f.keyword)));
  const fullKeywords = new Set(auditorResults.flatMap((r) => r.findings.map((f: any) => f.keyword)));
  const deltaRisks = {
    bareOnly: [...bareKeywords].filter((kw) => !fullKeywords.has(kw)),
    fullOnly: [...fullKeywords].filter((kw) => !bareKeywords.has(kw)),
    stable: [...bareKeywords].filter((kw) => fullKeywords.has(kw)),
  };

  const mergedResults = normalizePreAuditDimensions(
    mergeLocalFindingsIntoAudits(auditorResults, localFindings),
    systemAuditors,
  );
  const crossValidatedResults = await crossValidateRiskyDimensions(content, mergedResults, systemAuditors, caller);
  const report = await finalizePreAuditReport(
    content,
    localFindings,
    mergedResults,
    crossValidatedResults,
    systemAuditors,
    caller,
  );

  // Phase 2.2: 协同风险加权计算
  const dimensionLevels: Record<string, string> = {};
  for (const dim of crossValidatedResults) {
    dimensionLevels[dim.id] = dim.level ?? "🟢";
  }
  const timingFlag = localFindings.some((f) => f.timingWindowId) ? ["timing_risk"] : [];
  const synergy = calculateSynergy(dimensionLevels, timingFlag);
  report.synergyFlags = {
    triggered: synergy.triggered,
    overallMultiplier: synergy.overallMultiplier,
  };

  // 附加 delta 信号到报告
  report.deltaRisks = deltaRisks;

  return report;
}

async function runSystemAuditors(
  content: string,
  systemAuditors: Persona[],
  caller: AuditLlmCaller,
  timingContext?: string,
): Promise<PreAuditDimensionResult[]> {
  return Promise.all(
    systemAuditors.map(async (auditor) => {
      try {
        // 时机上下文仅注入给 social_risk 审计员
        const auditContent =
          timingContext && auditor.meta.id === "social_risk" ? [content, "", timingContext].join("\n") : content;

        const response = await caller({
          systemPrompt: [
            auditor.systemPrompt,
            "",
            "---",
            "",
            buildCompactAuditorCoT(auditor),
            "",
            "---",
            "",
            buildKevlarRiskDirective(),
          ].join("\n"),
          messages: [
            {
              role: "user",
              content: [
                `请按照你的推理框架对以下内容执行审查。`,
                ``,
                `执行顺序：`,
                `第一步：完成三视角解码`,
                `  - 视角A：内容的字面语义是什么？提取所有描述性词汇`,
                `  - 视角B：路人第一眼感知到什么？哪些词会让人停顿？`,
                `  - 视角C：恶意攻击者会截哪句话？把哪几个词组合在一起杀伤力最大？`,
                `           完整推演攻击链：原始表达 → 截图后呈现 → 评论区反应 → 舆情走向`,
                `第二步：执行你的维度专项推理`,
                `第三步：只输出 JSON findings，不输出推理过程`,
                ``,
                `重要：视角C发现的攻击点，无论是否匹配任何预设风险类型，都必须进入 findings。`,
                ``,
                `待审查内容：`,
                ``,
                auditContent,
              ].join("\n"),
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

async function handleOrchestrationAuditResult(
  tmpDir: string,
  state: ReviewWizardState,
  userPersonas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  try {
    const parsed = JSON.parse(stripCodeFence(userMessage.trim()));
    const dimensions = normalizePreAuditDimensions(parsed.dimensions, []);
    const report: PreAuditReport = {
      dimensions,
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : summarizePreAuditResults(dimensions),
      riskProfile: parsed.riskProfile ?? undefined,
      synergyFlags: parsed.synergyFlags ?? undefined,
      worstCaseNarrative: parsed.worstCaseNarrative ?? undefined,
      deltaRisks: parsed.deltaRisks ?? undefined,
    };

    // Phase 2.2: 宿主编排路径也执行协同风险加权计算
    if (!report.synergyFlags) {
      const dimensionLevels: Record<string, string> = {};
      for (const dim of dimensions) {
        dimensionLevels[dim.id] = dim.level ?? "🟢";
      }
      const timingFlag = dimensions.some((d) => d.findings?.some((f: any) => f.timingWindowId)) ? ["timing_risk"] : [];
      const synergy = calculateSynergy(dimensionLevels, timingFlag);
      report.synergyFlags = {
        triggered: synergy.triggered,
        overallMultiplier: synergy.overallMultiplier,
      };
    }

    state.preAuditReport = report;
    state.step = "checkPersonaInventory";
    await saveState(tmpDir, state);
    return handleInventoryCheck(tmpDir, state, userPersonas, samplingFn);
  } catch (err) {
    const info = getErrorInfo(err);
    return toolResponse(
      state,
      [
        "❌ 无法解析宿主 AI 返回的系统初审 JSON。",
        `错误：${info.message}`,
        "请让宿主 AI 仅返回合法 JSON，不要包含 Markdown 或解释文字，然后再次提交。",
      ].join("\n"),
    );
  }
}

// ── Pre-audit normalization and finalization ────────────────────────────────

interface PreAuditDimensionResult {
  id: string;
  name: string;
  findings: any[];
  level?: string;
}

function normalizePreAuditDimensions(raw: unknown, systemAuditors: Persona[]): PreAuditDimensionResult[] {
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
      .filter((finding) => finding && typeof finding === "object")
      .map((finding) => normalizeFinding(finding as Record<string, unknown>));
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

function normalizeFinding(finding: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...finding };
  const suggestedLevel = String(finding.suggestedLevel || "").trim();
  if (suggestedLevel !== "🔴" && suggestedLevel !== "🟡") {
    normalized.suggestedLevel = "🟡";
  }
  return normalized;
}

interface PreAuditReport {
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
  };
  worstCaseNarrative?: string;
  deltaRisks?: {
    bareOnly: string[];
    fullOnly: string[];
    stable: string[];
  };
}

async function finalizePreAuditReport(
  content: string,
  localFindings: any[], // Step 0
  mergedResults: PreAuditDimensionResult[], // Step 2
  crossValidatedResults: PreAuditDimensionResult[], // Step 3
  systemAuditors: Persona[],
  caller: AuditLlmCaller,
): Promise<PreAuditReport> {
  const fallbackDimensions = normalizePreAuditDimensions(crossValidatedResults, systemAuditors);
  try {
    const response = await caller({
      systemPrompt: buildPreAuditFinalizerPrompt(systemAuditors),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            content,
            localFindings, // Step 0
            mergedResults, // Step 2
            crossValidatedResults, // Step 3
          }),
        },
      ],
      maxTokens: 4096,
    });
    const parsed = JSON.parse(stripCodeFence(response.content.trim()));
    const dimensions = normalizePreAuditDimensions(parsed.dimensions, systemAuditors);
    return {
      dimensions,
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : summarizePreAuditResults(dimensions),
      riskProfile: parsed.riskProfile ?? undefined,
      synergyFlags: parsed.synergyFlags ?? undefined,
      worstCaseNarrative: parsed.worstCaseNarrative ?? undefined,
      deltaRisks: parsed.deltaRisks ?? undefined,
    };
  } catch (err) {
    logger.warn("Pre-audit finalizer failed, using deterministic summary", {
      event: "pre_audit_finalizer_failed",
      error: getErrorInfo(err).message,
    });
    return { dimensions: fallbackDimensions, summary: summarizePreAuditResults(fallbackDimensions) };
  }
}

async function buildLocalRuleFindings(skillsDir: string, content: string): Promise<any[]> {
  const repo = new LocalJsonRuleRepository(skillsDir);
  const loaded = await repo.loadRules();
  if (!loaded) return [];

  const findings: any[] = [];

  // ── Phase 0.1：时机节点检测 ─────────────────────────────────────────
  // L1 本地层仅标记命中，不决定风险等级（由 LLM L2 层判定）
  const timingFinding = repo.checkTimingRisk(new Date(), content);
  if (timingFinding) {
    findings.push({
      dimension: "时机风险",
      keyword: timingFinding.windowLabel,
      trigger: `时机窗口命中：${timingFinding.windowLabel}`,
      riskDescription: timingFinding.description,
      propagationRisk: `窗口期内风险系数 ${timingFinding.riskMultiplier}x，建议关注舆论放大效应。`,
      source: "local_rule_engine",
      timingWindowId: timingFinding.windowId,
      timingMultiplier: timingFinding.riskMultiplier,
      timingDescription: timingFinding.description,
    });
  }
  const seen = new Set<string>();

  // ── Phase 0a：现有 2-4 gram 滑动窗口匹配 ──────────────────────────────
  const candidates = extractAuditCandidates(content);

  for (const candidate of candidates) {
    const matches = repo.resolveVariant(candidate);
    for (const match of matches) {
      const key = `${candidate}::${match.rule.root}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const contextTerms = findContextRiskTerms(content, candidate);
      const level = contextTerms.length >= 2 || match.rule.severity === "HIGH" ? "🔴" : "🟡";
      findings.push({
        dimension: "网络文化误读",
        keyword: candidate,
        trigger: `本地规则命中：${candidate} -> ${match.rule.root}`,
        riskDescription: [
          `词根：${match.rule.root}`,
          `风险方向：${match.rule.misinterpret_direction}`,
          contextTerms.length > 0
            ? `邻近高风险修饰：${contextTerms.join("、")}`
            : "未发现明显邻近修饰，但仍需检查语境是否为正常食材/花草表达",
        ].join("；"),
        propagationRisk: "容易被截取为颜色/身体化暗示或低俗黑话，造成评论区恶意联想。",
        suggestedLevel: level,
        suggestion: match.rule.suggestion,
        source: "local_rule_engine",
        root: match.rule.root,
      });
    }
  }

  // ── Phase 0b：L2 结构模式检测 ─────────────────────────────────────────
  const structuralMatches = repo.checkStructuralPatterns(content);
  for (const sm of structuralMatches) {
    const key = `struct::${sm.patternId}::${sm.windowStart}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const matchedWordsStr = sm.matchedWords.map((m) => m.word).join("、");
    findings.push({
      dimension: "低俗擦边风险",
      keyword: matchedWordsStr,
      trigger: `语义类别组合命中：${sm.patternId}`,
      riskDescription: [
        `风险类型：${sm.riskType}`,
        `命中词：${matchedWordsStr}`,
        `位置范围：${sm.windowStart}-${sm.windowEnd}`,
      ].join("；"),
      propagationRisk: "多类别语义词在同一窗口内堆叠，容易被截图后进行颜色/身体向解读。",
      suggestedLevel: sm.suggestedLevel,
      source: "local_rule_engine",
      patternId: sm.patternId,
    });
  }

  return findings;
}

function extractAuditCandidates(content: string): string[] {
  const normalized = content.replace(/[\s,，。！？；;：:、"'""''()[\]{}<>《》|/\\-]+/g, "");
  const candidates = new Set<string>();
  for (let size = 2; size <= 4; size++) {
    for (let i = 0; i <= normalized.length - size; i++) {
      candidates.add(normalized.slice(i, i + size));
    }
  }
  return [...candidates];
}

function findContextRiskTerms(content: string, keyword: string): string[] {
  const riskTerms = ["贵妇", "粉嫩", "粉", "肥厚", "柔软", "嫩", "鲜嫩", "爆", "黑", "白", "红"];
  const keywordIndex = content.indexOf(keyword);
  const context =
    keywordIndex >= 0 ? content.slice(Math.max(0, keywordIndex - 12), keywordIndex + keyword.length + 24) : content;
  return riskTerms.filter((term) => context.includes(term));
}

function mergeLocalFindingsIntoAudits(
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
      name: "本地规则引擎",
      findings: localFindings,
      level: getFindingsLevel(localFindings),
    });
  }

  for (const audit of merged) {
    audit.level = getFindingsLevel(audit.findings || []);
  }

  return merged;
}

function getFindingsLevel(findings: any[]): string {
  let level = "🟢";
  for (const finding of findings) {
    if (finding.suggestedLevel === "🔴") return "🔴";
    if (finding.suggestedLevel === "🟡") level = "🟡";
  }
  return level;
}

// ── Phase 2: Cross-validation for risky dimensions ──

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
      "以下内容被「暗语破译」标记为网络文化风险。请从「语境脱嵌」角度验证：这些风险点脱离原始语境后，是否真的容易被断章取义或恶意曲解？请只输出 JSON。",
  },
  {
    source: "context_distortion",
    validator: "network_culture_risk",
    question:
      "以下内容被「语境猎手」标记为语境脱嵌风险。请从「网络文化」角度验证：这些风险点是否确实在特定网络社区有恶意含义？请只输出 JSON。",
  },
  {
    source: "social_risk",
    validator: "factual_integrity",
    question: "以下内容被「社伦判官」标记为社会风险。这些风险点有事实依据吗？还是纯粹基于情绪联想？请只输出 JSON。",
  },
  {
    source: "legal_compliance",
    validator: "social_risk",
    question: "以下内容被「合规哨兵」标记为合规风险。这些合规问题是否同时触发了社会对立？请只输出 JSON。",
  },
];

async function crossValidateRiskyDimensions(
  content: string,
  phase1Results: Array<{ id: string; name: string; findings: any[]; level?: string }>,
  auditors: Persona[],
  samplingFn: MultiTurnSamplingFunction,
): Promise<Array<{ id: string; name: string; findings: any[]; level?: string }>> {
  const riskyDimensions = phase1Results.filter((r) => r.findings && r.findings.length > 0);
  if (riskyDimensions.length === 0) return phase1Results;

  const validatorMap = new Map(auditors.map((a) => [a.meta.id, a]));
  const results = [...phase1Results.map((r) => ({ ...r, findings: [...r.findings] }))];

  for (const pair of CROSS_VALIDATION_PAIRS) {
    const sourceDim = riskyDimensions.find((r) => r.id === pair.source);
    if (!sourceDim || sourceDim.findings.length === 0) continue;

    const validatorAuditor = validatorMap.get(pair.validator);
    if (!validatorAuditor) continue;

    const findingsSummary = sourceDim.findings
      .map((f, i) => `${i + 1}. [${f.suggestedLevel}] ${f.keyword || ""} - ${f.trigger || f.riskDescription || ""}`)
      .join("\n");

    try {
      const response = await samplingFn({
        systemPrompt: validatorAuditor.systemPrompt,
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
      if (validatorDim && validatedFindings.length > 0) {
        for (const vf of validatedFindings) {
          const exists = validatorDim.findings.some((existing: any) => existing.keyword === vf.keyword);
          if (!exists) {
            validatorDim.findings.push(vf);
          }
        }
        validatorDim.level = getFindingsLevel(validatorDim.findings);
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

const CHINESE_DIMENSION_NAMES: Record<string, string> = {
  legal_compliance: "合规",
  context_distortion: "语境脱嵌",
  network_culture_risk: "网络文化",
  factual_integrity: "事实",
  social_risk: "社会风险",
  local_rule_engine: "本地规则",
};

function formatRiskyAuditorName(result: { id?: string; name: string }): string {
  const dimensionName = result.id ? CHINESE_DIMENSION_NAMES[result.id] : undefined;
  return dimensionName ? `${result.name}（${dimensionName}）` : result.name;
}

function escapeMarkdownTableCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatPreAuditTable(clean: Array<{ name: string; id?: string }>): string[] {
  if (clean.length === 0) return [];
  return [
    "| 审查维度 | 结果 |",
    "| --- | --- |",
    ...clean.map((r) => `| ${escapeMarkdownTableCell(r.name)} | ✅ 通过 |`),
  ];
}

function formatFindingRiskLine(finding: any): string {
  const keyword = finding.keyword
    ? `「${finding.keyword}」`
    : finding.dimension
      ? `「${finding.dimension}」`
      : "该内容";
  const parts = [
    finding.root ? `词根为"${finding.root}"` : undefined,
    finding.trigger,
    finding.riskDescription || finding.description,
    finding.propagationRisk,
  ].filter(Boolean);
  const detail = parts.length > 0 ? parts.join("；") : "存在潜在语义或传播风险，建议进入复审确认。";
  return `发现 1 项潜在风险：${keyword} ${detail}`;
}

function formatRiskSection(result: { id?: string; name: string; findings: any[] }): string[] {
  return [
    `⚠️ 风险预警（${formatRiskyAuditorName(result)}）`,
    ...(result.findings || []).map((finding) => formatFindingRiskLine(finding)),
  ];
}

function summarizePreAuditResults(
  results: Array<{ id?: string; name: string; findings: any[]; level?: string }>,
): string {
  if (results.length === 0) return "本地规则与系统审查员均未命中风险点";

  const risky: Array<{ name: string; findings: any[]; id?: string; level?: string }> = [];

  for (const r of results) {
    if (r.findings && r.findings.length > 0) {
      risky.push(r);
    }
  }

  // 全部通过
  if (risky.length === 0) {
    return [
      "⚠️ 风险发现",
      "",
      "| 维度 | 结果 |",
      "| --- | --- |",
      ...results.map((r) => `| ${escapeMarkdownTableCell(r.name)} | 🟢 通过 |`),
      "",
      "核心风险：无",
    ].join("\n");
  }

  // 有风险维度：只展示有风险的维度
  const riskSummaryLines = risky.map((r) => {
    const level = r.level || getFindingsLevel(r.findings);
    const riskKeywords = r.findings
      .map((f) => f.keyword || f.trigger)
      .filter(Boolean)
      .join("、");
    return `| ${escapeMarkdownTableCell(r.name)} | ${level} ${riskKeywords} |`;
  });

  // 核心风险总结：从所有 findings 中提取关键信息
  const coreRisk = buildCoreRiskSummary(risky);

  return [
    "⚠️ 风险发现",
    "",
    "| 维度 | 风险内容 |",
    "| --- | --- |",
    ...riskSummaryLines,
    "",
    "核心风险：",
    coreRisk,
  ].join("\n");
}

function buildCoreRiskSummary(
  risky: Array<{ name: string; findings: any[]; id?: string; level?: string }>,
): string {
  // 提取所有高风险关键词
  const highRiskKeywords: string[] = [];
  const riskDescriptions: string[] = [];

  for (const r of risky) {
    for (const f of r.findings) {
      if (f.suggestedLevel === "🔴" && f.keyword) {
        highRiskKeywords.push(f.keyword);
      }
      if (f.riskDescription) {
        riskDescriptions.push(f.riskDescription);
      }
    }
  }

  // 去重
  const uniqueKeywords = [...new Set(highRiskKeywords)];

  // 生成简洁的核心风险描述
  if (uniqueKeywords.length > 0) {
    const keywordStr = uniqueKeywords.join("、");
    const base = `文案中「${keywordStr}」存在明确风险联想`;
    if (riskDescriptions.length > 0) {
      return `${base}。${riskDescriptions[0]}`;
    }
    return `${base}，存在被截图传播演变为舆情事件的可能。`;
  }

  // 降级：用 riskDescription 拼接
  if (riskDescriptions.length > 0) {
    return riskDescriptions[0];
  }

  return "存在潜在语义或传播风险，建议进入复审确认。";
}

// ── 辅助：构建初审结果展示块 ─────────────────────────────────────────────────

function buildPreAuditSummaryBlock(state: ReviewWizardState): string {
  if (state.preAuditReport?.summary) {
    return [
      "<!-- kevlar:verbatim-pre-audit:start -->",
      `初审结果\n\n${state.preAuditReport.summary}`,
      "<!-- kevlar:verbatim-pre-audit:end -->",
    ].join("\n");
  }
  return [
    "<!-- kevlar:verbatim-pre-audit:start -->",
    "初审结果\n\n未找到系统审查员，跳过初审",
    "<!-- kevlar:verbatim-pre-audit:end -->",
  ].join("\n");
}

// ── 初审完成：展示结果并询问是否复审 ─────────────────────────────────────────
//
// 改造说明（原 handleInventoryCheck）：
// 原版把初审结果、评审员推荐、"开始复审"邀请混在同一条消息里。
// 改造后只展示初审结果 + 询问"是否需要复审"，step 置为 waitingForReviewDecision。
// 评审员推荐逻辑移至 handleReviewDecision，用户确认后才执行。

async function handleInventoryCheck(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  // 无评审员：提示创建，流程暂停
  if (personas.length === 0) {
    state.step = "waitingForPersonaCreation";
    state.selectedPersonaIds = [];
    state.remainingPersonaIds = [];
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        buildPreAuditSummaryBlock(state),
        "",
        "当前还没有可用评审员。请先创建至少一个角色，再继续这次内容评测。",
        "",
        "我已经暂存了本次待评测内容；创建角色后，带上这个 sessionId 再次调用 review_content_wizard 即可继续。",
      ].join("\n"),
    );
  }

  // 有评审员：展示初审结果，询问下一步
  state.step = "waitingForReviewDecision";
  await saveState(tmpDir, state);
  return toolResponse(
    state,
    [
      buildPreAuditSummaryBlock(state),
      "",
      "请选择下一步：",
      "1. 进入复审",
      "2. 平台合规检查（即将开放）",
    ].join("\n"),
  );
}

// ── 用户决定是否复审 ──────────────────────────────────────────────────────────

async function handleReviewDecision(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  const normalized = userMessage.trim();

  // 选项 2：平台合规检查（即将开放）
  if (/^(2|平台合规检查|合规检查|平台检查)$/i.test(normalized)) {
    return toolResponse(
      state,
      [
        "该功能正在开发中，敬请期待。",
        "",
        "请选择下一步：",
        "1. 进入复审",
        "2. 平台合规检查（即将开放）",
      ].join("\n"),
    );
  }

  // 选项 1：进入复审
  const wantsReview = /^(1|需要|开始复审|确认复审|执行复审|继续|好的|好|ok|yes)$/i.test(normalized);

  if (!wantsReview) {
    return toolResponse(
      state,
      [
        "请选择下一步：",
        "1. 进入复审",
        "2. 平台合规检查（即将开放）",
      ].join("\n"),
    );
  }

  // 用户确认复审：执行评审员推荐
  // 仅 1-2 位评审员：直接全选
  if (personas.length <= 2) {
    state.selectedPersonaIds = [...personas.map((p) => p.meta.id)];
    state.remainingPersonaIds = [];
    state.step = "waitingForReviewerConfirmation";
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        `当前共有 ${personas.length} 位评审员，已全部选中：`,
        "",
        ...personas.map(
          (p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.tags.join("、") || "通用"} · ${p.meta.description}`,
        ),
        "",
        "请回复「开始复审」确认执行，或回复「X 换一位」替换指定评审员（例如：2 换一位）。",
      ].join("\n"),
    );
  }

  // 3 位及以上：AI 推荐 1-3 位
  const recommendation = await recommendPersonas(state, personas, samplingFn);
  const recommendedIds = new Set(recommendation.personaIds);

  state.selectedPersonaIds = [...recommendation.personaIds];
  state.remainingPersonaIds = personas.filter((p) => !recommendedIds.has(p.meta.id)).map((p) => p.meta.id);
  state.step = "waitingForReviewerConfirmation";
  await saveState(tmpDir, state);

  const remainingPersonas = personas.filter((p) => !recommendedIds.has(p.meta.id));
  return toolResponse(
    state,
    [
      recommendation.assistantMessage,
      "",
      ...(remainingPersonas.length > 0
        ? [
            "**备选评审员**（暂未选入）：",
            ...remainingPersonas.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
          ]
        : []),
      "",
      "请回复「开始复审」确认执行，或回复「X 换一位」替换指定评审员（例如：2 换一位）。",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

// ── 等待用户确认评审员 ────────────────────────────────────────────────────────

async function handleReviewerConfirmation(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  const normalized = userMessage.trim();

  // Parse "X 换一位"
  const swapMatch = normalized.match(/^(\d+)\s*换一位$/);
  if (swapMatch) {
    const idx = parseInt(swapMatch[1], 10);
    return handleSwapReviewer(tmpDir, state, personas, idx);
  }

  // "开始复审" → 直接执行完整复审
  if (/^(开始复审|确认复审|执行复审)$/.test(normalized)) {
    if (state.selectedPersonaIds.length === 0) {
      return toolResponse(state, "❌ 当前没有已选择的复审评审员。请先通过「X 换一位」选择评审员后再试。");
    }
    return executeReview(skillsDir, tmpDir, state, samplingFn);
  }

  // 未识别 → 重新展示当前评审员状态
  await saveState(tmpDir, state);
  const selectedUserPersonas = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
  const remaining = personas.filter((p) => state.remainingPersonaIds.includes(p.meta.id));
  return toolResponse(
    state,
    [
      "当前已选复审评审员：",
      ...selectedUserPersonas.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
      "",
      ...(remaining.length > 0
        ? [`备选评审员（共 ${remaining.length} 位）`, "请回复「X 换一位」替换指定评审员（例如：2 换一位）。"]
        : []),
      "",
      "请回复「开始复审」确认执行，或回复「X 换一位」替换指定评审员。",
    ].join("\n"),
  );
}

async function handleSwapReviewer(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  position: number,
): Promise<ToolResult> {
  if (position < 1 || position > state.selectedPersonaIds.length) {
    const selected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
    return toolResponse(
      state,
      [
        `❌ 编号 ${position} 超出范围。当前已选复审评审员：`,
        ...selected.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
        "",
        "请重新输入正确的编号。",
      ].join("\n"),
    );
  }

  // 备选池为空
  if (state.remainingPersonaIds.length === 0) {
    const selected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
    return toolResponse(
      state,
      [
        "⚠️ 备选池已没有可替换的评审员。",
        "",
        "当前已选复审评审员：",
        ...selected.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
        "",
        "请回复「开始复审」确认执行。",
      ].join("\n"),
    );
  }

  const removedId = state.selectedPersonaIds[position - 1];
  const removedPersona = personas.find((p) => p.meta.id === removedId);

  const addedId = state.remainingPersonaIds.shift()!;
  state.selectedPersonaIds = state.selectedPersonaIds.filter((id) => id !== removedId);
  state.selectedPersonaIds.push(addedId);
  state.remainingPersonaIds.push(removedId);

  state.step = "waitingForReviewerConfirmation";
  await saveState(tmpDir, state);

  const updatedSelected = personas.filter((p) => state.selectedPersonaIds.includes(p.meta.id));
  const remaining = personas.filter((p) => state.remainingPersonaIds.includes(p.meta.id));
  const addedPersona = personas.find((p) => p.meta.id === addedId);

  return toolResponse(
    state,
    [
      `✅ 已替换：${removedPersona?.meta.name || "未知"} → ${addedPersona?.meta.name || "未知"}`,
      "",
      "当前已选复审评审员：",
      ...updatedSelected.map((p, i) => `${i + 1}. ${p.meta.name} · ${p.meta.description}`),
      "",
      ...(remaining.length > 0 ? [`备选评审员（共 ${remaining.length} 位）`] : []),
      "请回复「开始复审」确认执行，或回复「X 换一位」继续替换。",
    ].join("\n"),
  );
}

async function recommendPersonas(
  state: ReviewWizardState,
  personas: Persona[],
  samplingFn?: MultiTurnSamplingFunction,
): Promise<Recommendation> {
  // First try RST-based recommendation for RST-configured personas
  const rstRecommendation = recommendRSTPersonas(
    state.content,
    state.preAuditReport,
    personas,
    state.context || undefined,
  );

  if (rstRecommendation.personaIds.length > 0 && rstRecommendation.assistantMessage) {
    return rstRecommendation;
  }

  // Fall back to AI recommendation if MCP sampling is available
  if (samplingFn) {
    try {
      const personaSummary = personas.map((p) => ({
        id: p.meta.id,
        name: p.meta.name,
        tags: p.meta.tags,
        description: p.meta.description,
      }));
      const include = {
        content: state.content,
        context: state.context || "",
        personas: personaSummary,
      } as Record<string, unknown>;
      if (state.preAuditReport) {
        include.preAuditReport = state.preAuditReport;
      }
      const response = await samplingFn({
        systemPrompt:
          '你是评审员推荐助手。根据待评测内容和系统初审报告推荐 1-3 个最匹配的评审员，输出 JSON：{"personaIds":["id"],"assistantMessage":"推荐理由"}。assistantMessage 应包含「根据内容特色和初审发现的风险点，为您推荐了 X 位合适的评审员」及每位推荐评审员的简要理由。不要输出 markdown。',
        messages: [
          {
            role: "user",
            content: JSON.stringify(include),
          },
        ],
        maxTokens: 3072,
      });
      const parsed = JSON.parse(stripCodeFence(response.content.trim())) as Record<string, unknown>;
      const validIds = new Set(personas.map((p) => p.meta.id));
      const personaIds = Array.isArray(parsed.personaIds)
        ? parsed.personaIds
            .map(String)
            .filter((id) => validIds.has(id))
            .slice(0, 3)
        : [];
      if (personaIds.length > 0 && typeof parsed.assistantMessage === "string") {
        return { personaIds, assistantMessage: parsed.assistantMessage };
      }
    } catch (err) {
      const info = getErrorInfo(err);
      logger.warn("AI persona recommendation failed, falling back to heuristic", {
        event: "review_recommendation_fallback",
        error: info.code,
        message: info.message,
      });
    }
  }

  return heuristicRecommendation(state, personas);
}

function heuristicRecommendation(state: ReviewWizardState, personas: Persona[]): Recommendation {
  const terms = `${state.content}\n${state.context || ""}`.toLowerCase();
  const scored = personas
    .map((p) => {
      const score =
        p.meta.tags.reduce((sum, tag) => sum + (terms.includes(tag.toLowerCase()) ? 2 : 0), 0) +
        (terms.includes(p.meta.name.toLowerCase()) ? 3 : 0);
      return { persona: p, score };
    })
    .sort((a, b) => b.score - a.score);

  const selected = scored.slice(0, Math.min(3, personas.length)).map((item) => item.persona);
  return {
    personaIds: selected.map((p) => p.meta.id),
    assistantMessage: [
      "根据内容特色，为您推荐了以下评审员：",
      "",
      ...selected.map((p) => `- ${p.meta.name}（推荐理由：标签与描述和本次内容更接近）`),
      "",
      "请向用户展示以上推荐结果，等待用户选择。",
    ].join("\n"),
  };
}

async function executeReview(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  samplingFn?: MultiTurnSamplingFunction,
): Promise<ToolResult> {
  const reviewResult = await handleReviewContent(skillsDir, {
    content: state.content,
    persona_ids: state.selectedPersonaIds,
    context: state.context,
    mode: "auto",
    dimensions: state.dimensions,
    preAuditReport: state.preAuditReport,
    samplingFn: samplingFn
      ? async (params) =>
          samplingFn({
            systemPrompt: params.systemPrompt,
            messages: [{ role: "user", content: params.message }],
            maxTokens: params.maxTokens,
          })
      : undefined,
  });

  if (reviewResult.isError) {
    return {
      content: [{ type: "text", text: reviewResult.content[0]?.text || "❌ 评测执行失败。" }],
      isError: true,
    };
  }

  state.step = "completed";
  const resultText = reviewResult.content[0]?.text || "";
  const response = toolResponse(state, resultText + "\n\n---\n\n评测完成。");
  await cleanupState(tmpDir, state.sessionId);
  return response;
}

async function loadOrCreateState(tmpDir: string, input: ReviewWizardInput): Promise<ReviewWizardState> {
  if (input.sessionId && !/^[a-z0-9-]+$/.test(input.sessionId)) {
    throw new Error("sessionId 格式不合法。");
  }

  const sessionId = input.sessionId || `wizard-review-${Math.random().toString(36).substring(2, 10)}`;
  const statePath = getStatePath(tmpDir, sessionId);

  if (input.sessionId && fs.existsSync(statePath)) {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    const state = JSON.parse(raw) as ReviewWizardState;
    if (!state.dimensions) {
      state.dimensions = { ...DEFAULT_DIMENSIONS_CONFIG };
    }
    if (Date.now() - state.createdAt > 10 * 60 * 1000) {
      await cleanupState(tmpDir, sessionId);
      return {
        sessionId,
        createdAt: Date.now(),
        step: "systemAudit",
        content: state.content,
        targetPlatforms: [],
        selectedPersonaIds: [],
        remainingPersonaIds: [],
        systemAuditorIds: [],
        dimensions: { ...DEFAULT_DIMENSIONS_CONFIG },
      };
    }
    if (!state.systemAuditorIds) {
      state.systemAuditorIds = [];
    }
    return state;
  }

  return {
    sessionId,
    createdAt: Date.now(),
    step: "systemAudit",
    content: input.userMessage.trim(),
    targetPlatforms: [],
    selectedPersonaIds: [],
    remainingPersonaIds: [],
    systemAuditorIds: [],
    dimensions: { ...DEFAULT_DIMENSIONS_CONFIG },
  };
}

async function saveState(tmpDir: string, state: ReviewWizardState): Promise<void> {
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const statePath = getStatePath(tmpDir, state.sessionId);
  const tmpPath = statePath + ".tmp";
  await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  await fs.promises.rename(tmpPath, statePath);
}

async function cleanupState(tmpDir: string, sessionId: string): Promise<void> {
  const statePath = getStatePath(tmpDir, sessionId);
  try {
    if (fs.existsSync(statePath)) await fs.promises.unlink(statePath);
  } catch (err) {
    const info = getErrorInfo(err);
    logger.warn("Failed to clean review wizard state", {
      event: "review_wizard_cleanup_error",
      path: statePath,
      error: info.code,
      message: info.message,
    });
  }
}

function getStatePath(tmpDir: string, sessionId: string): string {
  return path.join(tmpDir, `${sessionId}_review_wizard.json`);
}

function toolResponse(state: ReviewWizardState, assistantMessage: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          assistantMessage,
          "",
          "```kevlar-state",
          `sessionId: ${state.sessionId}`,
          "workflow: review_content",
          `currentStep: ${state.step}`,
          `targetPlatforms: ${state.targetPlatforms.join(", ") || "none"}`,
          `selectedPersonaIds: ${state.selectedPersonaIds.join(", ") || "none"}`,
          `remainingPersonaIds: ${state.remainingPersonaIds.join(", ") || "none"}`,
          `dimensions: defensive=${DEFENSIVE_DIMENSION_IDS.length}(system), offensive=${state.dimensions.offensive.length}`,
          "```",
        ].join("\n"),
      },
    ],
  };
}

function stripCodeFence(text: string): string {
  if (!text.startsWith("```")) return text;
  return text
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}
