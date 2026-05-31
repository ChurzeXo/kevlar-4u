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
import { TOOL_DESCRIPTION, buildOrchestrationPrompt, buildPreAuditFinalizerPrompt } from "../prompts/reviewWizard.js";

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
    const preAuditReport = await executeLlmSystemAudit(state.content, systemAuditors, localFindings, caller);
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
): Promise<{ dimensions: PreAuditDimensionResult[]; summary: string }> {
  const auditorResults = await runSystemAuditors(content, systemAuditors, localFindings, caller);
  const mergedResults = normalizePreAuditDimensions(
    mergeLocalFindingsIntoAudits(auditorResults, localFindings),
    systemAuditors,
  );
  const crossValidatedResults = await crossValidateRiskyDimensions(content, mergedResults, systemAuditors, caller);
  return finalizePreAuditReport(content, localFindings, mergedResults, crossValidatedResults, systemAuditors, caller);
}

async function runSystemAuditors(
  content: string,
  systemAuditors: Persona[],
  localFindings: any[],
  caller: AuditLlmCaller,
): Promise<PreAuditDimensionResult[]> {
  const localContext = formatLocalFindingsForPrompt(localFindings);
  return Promise.all(
    systemAuditors.map(async (auditor) => {
      try {
        const response = await caller({
          systemPrompt: [auditor.systemPrompt, "", "---", "", buildKevlarRiskDirective()].join("\n"),
          messages: [
            {
              role: "user",
              content: [localContext, "请审查以下内容：", "", content].filter(Boolean).join("\n"),
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
    state.preAuditReport = {
      dimensions,
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : summarizePreAuditResults(dimensions),
    };
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

async function finalizePreAuditReport(
  content: string,
  localFindings: any[],
  auditorResults: PreAuditDimensionResult[],
  crossValidatedResults: PreAuditDimensionResult[],
  systemAuditors: Persona[],
  caller: AuditLlmCaller,
): Promise<{ dimensions: PreAuditDimensionResult[]; summary: string }> {
  const fallbackDimensions = normalizePreAuditDimensions(crossValidatedResults, systemAuditors);
  try {
    const response = await caller({
      systemPrompt: buildPreAuditFinalizerPrompt(systemAuditors),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            content,
            localFindings,
            auditorResults,
            crossValidatedResults,
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
  const seen = new Set<string>();
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

  const risky: Array<{ name: string; findings: any[]; id?: string }> = [];
  const clean: Array<{ name: string; id?: string }> = [];

  for (const r of results) {
    const hasFindings = r.findings && r.findings.length > 0;
    if (hasFindings) {
      risky.push(r);
    } else {
      clean.push(r);
    }
  }

  const lines: string[] = [];

  const tableLines = formatPreAuditTable(clean);
  if (tableLines.length > 0) {
    lines.push(...tableLines);
  }

  if (risky.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      ...risky.flatMap((r, index) => {
        const section = formatRiskSection(r);
        return index === 0 ? section : ["", ...section];
      }),
    );
  }

  if (risky.length === 0 && clean.length > 0) {
    lines.push("");
    lines.push(`✅ 合规通过：${clean.map((r) => r.name).join(" · ")}`);
  }

  return lines.join("\n");
}

function formatLocalFindingsForPrompt(localFindings: any[]): string {
  if (localFindings.length === 0) return "";
  return [
    "【本地规则初审命中】",
    ...localFindings.map((f) =>
      [
        `- ${f.suggestedLevel || "⚪"} ${f.keyword} -> ${f.root || "未知词根"}`,
        `  - 触发原因：${f.trigger}`,
        `  - 风险描述：${f.riskDescription}`,
      ].join("\n"),
    ),
    "",
  ].join("\n");
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

  // 有评审员：展示初审结果，询问是否需要复审
  state.step = "waitingForReviewDecision";
  await saveState(tmpDir, state);
  return toolResponse(
    state,
    [
      buildPreAuditSummaryBlock(state),
      "",
      "初审已完成。是否需要进入复审？",
      "",
      "回复「需要」或「开始复审」即可，我会为你推荐合适的复审评审员。",
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

  // 宽松识别确认复审意图（"好"需要完整词边界，不匹配"这篇不好"中的"好"）
  const wantsReview = /^(?:需要|开始复审|确认复审|执行复审|继续|好的|好|ok|yes)$|^开始$|^确认$|^需要$|^是$|^嗯$/i.test(normalized);

  if (!wantsReview) {
    return toolResponse(state, "请回复「需要」进入复审，或告诉我你的其他需求。");
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
