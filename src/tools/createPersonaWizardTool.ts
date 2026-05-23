import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import { MultiTurnSamplingFunction } from "../execution/base.js";
import { handleCreatePersona } from "./createPersonaTool.js";
import { logger } from "../utils/logger.js";

const AGE_RANGE_OPTIONS = [
  { value: "18岁以下", label: "18岁以下" },
  { value: "18-24岁", label: "18-24岁" },
  { value: "25-30岁", label: "25-30岁" },
  { value: "30-35岁", label: "30-35岁" },
  { value: "35-40岁", label: "35-40岁" },
  { value: "40岁以上", label: "40岁以上" },
];

export const createPersonaWizardToolDefinition: Tool = {
  name: "create_persona_wizard",
  description:
    "当用户说「创建/新建/自定义评论员/人设/角色」时，调用此工具。首次调用不带 sessionId，将 userMessage 设为用户的原话；工具会引导用户逐步完成年龄段、兴趣方向、性格特质、常用平台等信息收集。完全独立，不涉及内容评测流程。",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description:
          "人设创建向导的会话标识。首次调用请留空，工具会自动生成并返回一个 sessionId。后续调用必须传入此值以继续上一次的创建会话。",
      },
      userMessage: {
        type: "string",
        description:
          "用户在当前步骤的回复内容。首次调用时直接传入用户原话（例如「帮我创建一个时尚类评论员」），工具开始分步引导。后续步骤传入用户对工具提问的回复。",
      },
    },
    required: ["userMessage"],
  },
};

export interface WizardInput {
  sessionId?: string;
  userMessage: string;
  samplingFn?: MultiTurnSamplingFunction;
}

type WizardStep =
  | "ageRange"
  | "interests"
  | "traits"
  | "platform"
  | "authorRelation"
  | "finalConfirm"
  | "completed";

type DraftField = "ageRange" | "interests" | "traits" | "platform" | "authorRelation";

interface WizardState {
  sessionId: string;
  createdAt: number;
  step: WizardStep;
  fields: {
    ageRange?: string;
    interests?: string[];
    traits?: string[];
    platform?: string;
    culturalContext?: string;
    authorRelation?: string;
    stance?: string;
    blindSpot?: string;
  };
}

interface ExtractionResult {
  value: string | string[];
  assistantMessage: string;
}

export async function handleCreatePersonaWizard(
  skillsDir: string,
  tmpDir: string,
  input: WizardInput
): Promise<ToolResult> {
  const { userMessage, samplingFn } = input;

  if (!userMessage || typeof userMessage !== "string") {
    return {
      content: [{ type: "text", text: "❌ 请提供当前步骤的用户回复。" }],
      isError: true,
    };
  }

  try {
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const state = await loadOrCreateState(tmpDir, input.sessionId);
    if (!input.sessionId) {
      await saveState(tmpDir, state);
      return toolResponse(
        state,
        [
          "请选择这个角色的年龄段（回复编号或文字）：",
          "",
          "1. 18岁以下",
          "2. 18-24岁",
          "3. 25-30岁",
          "4. 30-35岁",
          "5. 35-40岁",
          "6. 40岁以上",
        ].join("\n")
      );
    }
    const result = await advanceWizard(skillsDir, tmpDir, state, userMessage, samplingFn);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Create persona wizard failed", { event: "wizard_error", error: message });
    return {
      content: [{ type: "text", text: `❌ 人设创建向导失败：${message}` }],
      isError: true,
    };
  }
}

async function advanceWizard(
  skillsDir: string,
  tmpDir: string,
  state: WizardState,
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  switch (state.step) {
    case "ageRange": {
      const resolved = resolveAgeRange(userMessage);
      if (!resolved) {
        return toolResponse(
          state,
          [
            "请从以下选项中选择（回复编号或文字）：",
            "",
            "1. 18岁以下",
            "2. 18-24岁",
            "3. 25-30岁",
            "4. 30-35岁",
            "5. 35-40岁",
            "6. 40岁以上",
          ].join("\n")
        );
      }
      state.fields.ageRange = resolved;
      state.step = "interests";
      await saveState(tmpDir, state);
      await saveDraft(tmpDir, state);
      return toolResponse(
        state,
        [
          `已记录年龄段：${state.fields.ageRange}`,
          "",
          "第二步：请描述这个角色的兴趣方向",
          "副标题：举几个例子，例如：美食、旅行、科技、育儿、健身……",
        ].join("\n")
      );
    }

    case "interests": {
      const extracted = await extractInterests(userMessage, samplingFn);
      state.fields.interests = normalizeStringArray(extracted.value);
      state.step = "traits";
      await saveState(tmpDir, state);
      await saveDraft(tmpDir, state);
      return toolResponse(
        state,
        [
          extracted.assistantMessage,
          "",
          "第三步：请描述这个角色的性格特质",
          "自由描述即可，例如：容易跟风、对价格敏感、喜欢对比评测……",
        ].join("\n")
      );
    }

    case "traits": {
      const extracted = await extractTraits(userMessage, samplingFn);
      state.fields.traits = normalizeStringArray(extracted.value);
      state.step = "platform";
      await saveState(tmpDir, state);
      await saveDraft(tmpDir, state);
      return toolResponse(
        state,
        [
          extracted.assistantMessage,
          "",
          "第四步：内容主要投放平台",
          "如果多平台投放，建议创建更多针对某一平台的虚拟评论员。",
        ].join("\n")
      );
    }

    case "platform": {
      const raw = userMessage.trim();
      if (/[和、/,]/.test(raw)) {
        const first = raw.split(/[和、/,]/)[0].trim();
        if (first) {
          state.fields.platform = first;
          state.step = "authorRelation";
          await saveState(tmpDir, state);
          await saveDraft(tmpDir, state);
          return toolResponse(
            state,
            [
              `已记录常用平台：${state.fields.platform}`,
              "⚠️ 一次只创建一个平台对应的评论员。如需多平台覆盖，请逐一创建。",
              "",
              "请选择这个角色与作者的关系（回复编号或文字）：",
              "",
              "1. 已关注（信任阈值较高，但期望值也更高）",
              "2. 未关注（信任阈值较低，更容易因细节问题流失注意力）",
            ].join("\n")
          );
        }
      }
      state.fields.platform = raw;
      state.step = "authorRelation";
      await saveState(tmpDir, state);
      await saveDraft(tmpDir, state);
      return toolResponse(
        state,
        [
          `已记录常用平台：${state.fields.platform}`,
          "",
          "请选择这个角色与作者的关系（回复编号或文字）：",
          "",
          "1. 已关注（信任阈值较高，但期望值也更高）",
          "2. 未关注（信任阈值较低，更容易因细节问题流失注意力）",
        ].join("\n")
      );
    }

    case "authorRelation": {
      const resolved = resolveAuthorRelation(userMessage);
      if (!resolved) {
        return toolResponse(
          state,
          [
            "请从以下选项中选择（回复编号或文字）：",
            "",
            "1. 已关注",
            "2. 未关注",
          ].join("\n")
        );
      }
      state.fields.authorRelation = resolved;
      state.step = "finalConfirm";
      await saveState(tmpDir, state);
      await saveDraft(tmpDir, state);
      return toolResponse(state, buildFinalConfirmationMessage(state));
    }

    case "finalConfirm":
      if (isAffirmative(userMessage)) {
        return completeWizard(skillsDir, tmpDir, state, samplingFn);
      }

      {
        const modified = await applyFinalModification(state, userMessage, samplingFn);
        if (!modified) {
          return toolResponse(state, "请说明要修改哪个字段：年龄段、兴趣方向、性格特质或常用平台。");
        }
        await saveState(tmpDir, state);
        await saveDraft(tmpDir, state);
        return toolResponse(
          state,
          [`已更新${fieldLabel(modified)}。`, "", buildFinalConfirmationMessage(state)].join("\n")
        );
      }

    case "completed":
      return toolResponse(state, "这个人设创建流程已经完成。需要创建新角色时，请重新开始一个会话。");
  }
}

async function applyFinalModification(
  state: WizardState,
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction
): Promise<DraftField | undefined> {
  const field = detectModifiedField(userMessage);
  if (!field) return undefined;

  const valueText = extractModificationValue(userMessage, field);
  if (!valueText) return undefined;

  switch (field) {
    case "ageRange":
      state.fields.ageRange = valueText;
      break;
    case "interests": {
      const extracted = await extractInterests(valueText, samplingFn);
      state.fields.interests = normalizeStringArray(extracted.value);
      break;
    }
    case "traits": {
      const extracted = await extractTraits(valueText, samplingFn);
      state.fields.traits = normalizeStringArray(extracted.value);
      break;
    }
    case "platform":
      state.fields.platform = valueText;
      break;
    case "authorRelation":
      state.fields.authorRelation = valueText;
      break;
  }

  state.step = "finalConfirm";
  return field;
}

async function completeWizard(
  skillsDir: string,
  tmpDir: string,
  state: WizardState,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  const inferred = await inferFinalFields(state, samplingFn);
  state.fields = { ...state.fields, ...inferred };
  state.step = "completed";
  await saveState(tmpDir, state);
  await saveDraft(tmpDir, state);

  const createResult = await handleCreatePersona(skillsDir, tmpDir, {
    name: inferPersonaName(state),
    sessionId: state.sessionId,
    culturalContext: state.fields.culturalContext,
    authorRelation: state.fields.authorRelation,
    stance: state.fields.stance,
    blindSpot: state.fields.blindSpot,
  });

  if (!createResult.isError) {
    await cleanupState(tmpDir, state.sessionId);
  }

  return createResult;
}

async function extractInterests(
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ExtractionResult> {
  if (samplingFn) {
    try {
      const json = await runJsonExtraction(samplingFn, {
        systemPrompt:
          "你是字段提炼器。请把用户对兴趣方向的自然语言描述提炼为最多 3 个中文短标签，并严格输出 JSON：{\"interests\":[\"标签\"],\"assistantMessage\":\"整理说明\"}。assistantMessage 只说明已总结的标签，不要要求用户确认。不要输出 markdown。",
        userMessage,
      });
      const interests = normalizeStringArray(json.interests).slice(0, 3);
      if (interests.length > 0) {
        return {
          value: interests,
          assistantMessage:
            typeof json.assistantMessage === "string"
              ? sanitizeStepAssistantMessage(json.assistantMessage)
              : `我帮你总结为以下标签：${interests.join("、")}。`,
        };
      }
    } catch (err) {
      logger.warn("Sampling extraction failed for interests, falling back to heuristic", {
        event: "sampling_interests_fallback",
        error: String(err),
      });
    }
  }

  const interests = splitUserText(userMessage, 3);
  return {
    value: interests,
    assistantMessage: `我帮你总结为以下标签：${interests.join("、")}。`,
  };
}

async function extractTraits(
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ExtractionResult> {
  if (samplingFn) {
    try {
      const json = await runJsonExtraction(samplingFn, {
        systemPrompt:
          "你是字段提炼器。请把用户对性格特质的自然语言描述提炼为最多 4 条「特质 → 行为描述」字符串，并严格输出 JSON：{\"traits\":[\"特质 → 因此当 X 时，会 Y\"],\"assistantMessage\":\"整理说明\"}。assistantMessage 只说明已总结的性格特质，不要要求用户确认。不要输出 markdown。",
        userMessage,
      });
      const traits = normalizeStringArray(json.traits).slice(0, 4).map(normalizeTrait);
      if (traits.length > 0) {
        return {
          value: traits,
          assistantMessage:
            typeof json.assistantMessage === "string"
              ? sanitizeStepAssistantMessage(json.assistantMessage)
              : `我帮你总结为以下性格特质：\n${traits.map((t) => `- ${t}`).join("\n")}`,
        };
      }
    } catch (err) {
      logger.warn("Sampling extraction failed for traits, falling back to heuristic", {
        event: "sampling_traits_fallback",
        error: String(err),
      });
    }
  }

  const traits = splitUserText(userMessage, 4).map(normalizeTrait);
  return {
    value: traits,
    assistantMessage: `我帮你总结为以下性格特质：\n${traits.map((t) => `- ${t}`).join("\n")}`,
  };
}

async function inferFinalFields(
  state: WizardState,
  samplingFn?: MultiTurnSamplingFunction
): Promise<Pick<WizardState["fields"], "culturalContext" | "authorRelation" | "stance" | "blindSpot">> {
  const fallback = {
    culturalContext: inferCulturalContext(state),
    authorRelation: state.fields.authorRelation || "未关注",
    stance: "默认质疑",
    blindSpot: "无特定盲区",
  };

  if (!samplingFn) return fallback;

  try {
    const json = await runJsonExtraction(samplingFn, {
      systemPrompt:
        "你是人设属性推断器。根据已确认字段推断 culturalContext、stance、blindSpot，并严格输出 JSON：{\"culturalContext\":\"...\",\"stance\":\"...\",\"blindSpot\":\"...\"}。authorRelation 已由用户明确选择，不要覆盖。不要输出 markdown。",
      userMessage: JSON.stringify(state.fields),
    });
    return {
      culturalContext: typeof json.culturalContext === "string" ? json.culturalContext : fallback.culturalContext,
      authorRelation: fallback.authorRelation,
      stance: typeof json.stance === "string" ? json.stance : fallback.stance,
      blindSpot: typeof json.blindSpot === "string" ? json.blindSpot : fallback.blindSpot,
    };
  } catch {
    return fallback;
  }
}

async function runJsonExtraction(
  samplingFn: MultiTurnSamplingFunction,
  params: { systemPrompt: string; userMessage: string }
): Promise<Record<string, unknown>> {
  const response = await samplingFn({
    systemPrompt: params.systemPrompt,
    messages: [{ role: "user", content: params.userMessage }],
    maxTokens: 1024,
  });
  const jsonText = stripCodeFence(response.content.trim());
  return JSON.parse(jsonText) as Record<string, unknown>;
}

function stripCodeFence(text: string): string {
  if (!text.startsWith("```")) return text;
  return text.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
}

async function loadOrCreateState(tmpDir: string, inputSessionId?: string): Promise<WizardState> {
  if (inputSessionId && !/^[a-z0-9-]+$/.test(inputSessionId)) {
    throw new Error("sessionId 格式不合法。");
  }

  const sessionId = inputSessionId || `wizard-create-${Math.random().toString(36).substring(2, 10)}`;
  const statePath = getStatePath(tmpDir, sessionId);

  if (inputSessionId && fs.existsSync(statePath)) {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    return JSON.parse(raw) as WizardState;
  }

  return {
    sessionId,
    createdAt: Date.now(),
    step: "ageRange",
    fields: {},
  };
}

async function saveState(tmpDir: string, state: WizardState): Promise<void> {
  await fs.promises.mkdir(tmpDir, { recursive: true });
  await fs.promises.writeFile(getStatePath(tmpDir, state.sessionId), JSON.stringify(state, null, 2), "utf-8");
}

async function saveDraft(tmpDir: string, state: WizardState): Promise<void> {
  const draft = {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    step: stepNumber(state),
    fields: state.fields,
  };
  await fs.promises.writeFile(getDraftPath(tmpDir, state.sessionId), JSON.stringify(draft, null, 2), "utf-8");
}

async function cleanupState(tmpDir: string, sessionId: string): Promise<void> {
  for (const filePath of [getStatePath(tmpDir, sessionId), getDraftPath(tmpDir, sessionId)]) {
    try {
      if (fs.existsSync(filePath)) await fs.promises.unlink(filePath);
    } catch (err) {
      logger.warn("Failed to clean wizard file", { event: "wizard_cleanup_error", path: filePath, error: String(err) });
    }
  }
}

function getStatePath(tmpDir: string, sessionId: string): string {
  return path.join(tmpDir, `${sessionId}_wizard.json`);
}

function getDraftPath(tmpDir: string, sessionId: string): string {
  return path.join(tmpDir, `${sessionId}_draft.json`);
}

function toolResponse(state: WizardState, assistantMessage: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          assistantMessage,
          "",
          "```kevlar-state",
          `sessionId: ${state.sessionId}`,
          "workflow: create_persona",
          `currentStep: ${state.step}`,
          `completedFields: ${Object.keys(state.fields).join(", ") || "none"}`,
          "```",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  };
}

function buildFinalConfirmationMessage(state: WizardState): string {
  const fields = state.fields;
  return [
    "所有信息已收集完毕，请确认是否创建角色。",
    "",
    `年龄段：${fields.ageRange || ""}`,
    `兴趣方向：${fields.interests?.join("、") || ""}`,
    `常用平台：${fields.platform || ""}`,
    `与作者的关系：${fields.authorRelation || ""}`,
    "性格特质：",
    ...(fields.traits || []).map((trait) => `- ${trait}`),
    "",
    "如需修改，请直接说：年龄段改成... / 兴趣方向改成... / 性格特质改成... / 平台改成... / 关系改成...",
    "确认无误请回复：确认创建",
  ].join("\n");
}

function detectModifiedField(input: string): DraftField | undefined {
  if (/年龄|年龄段|\d+\s*[-到至]\s*\d+\s*岁|岁/.test(input)) return "ageRange";
  if (/兴趣|方向|标签/.test(input)) return "interests";
  if (/性格|特质|脾气|行为/.test(input)) return "traits";
  if (/平台|渠道|小红书|知乎|B站|公众号|微信|微博|Instagram|Reddit|YouTube|Twitter|X\b/i.test(input)) {
    return "platform";
  }
  if (/关系|关注|作者/.test(input)) return "authorRelation";
  return undefined;
}

function extractModificationValue(input: string, field: DraftField): string {
  const trimmed = input.trim();
  const explicitMatch = trimmed.match(/(?:改成|改为|修改为|换成|变成|调整为|设置为|[:：])\s*(.+)$/);
  if (explicitMatch?.[1]) return explicitMatch[1].trim();

  const fieldWords: Record<DraftField, RegExp> = {
    ageRange: /年龄段?|岁数?/g,
    interests: /兴趣方向|兴趣|方向|标签/g,
    traits: /性格特质|性格|特质|脾气|行为/g,
    platform: /常用平台|平台|渠道/g,
    authorRelation: /与作者的关系|关系|关注/g,
  };
  const cleaned = trimmed
    .replace(fieldWords[field], "")
    .replace(/^(请|帮我|把|将|给我|重新)?\s*/, "")
    .replace(/(改一下|修改一下|调整一下|改|修改|调整|换)\s*/g, "")
    .trim();

  return cleaned || trimmed;
}

function fieldLabel(field: DraftField): string {
  const labels: Record<DraftField, string> = {
    ageRange: "年龄段",
    interests: "兴趣方向",
    traits: "性格特质",
    platform: "常用平台",
    authorRelation: "与作者的关系",
  };
  return labels[field];
}

function sanitizeStepAssistantMessage(input: string): string {
  return input
    .replace(/确认没问题吗？?如需调整请直接告诉我。?/g, "")
    .replace(/确认没问题吗？?/g, "")
    .replace(/如需调整请直接告诉我。?/g, "")
    .trim();
}

function isAffirmative(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  // Short/ambiguous words require exact match to avoid false positives.
  // e.g. "确认没问题" should match via containsMatchWords; "这是什么" should NOT match.
  const exactMatchWords = ["是", "对", "好", "y"];
  const containsMatchWords = ["确认", "可以", "没问题", "ok", "yes"];
  return (
    exactMatchWords.some((w) => normalized === w) ||
    containsMatchWords.some((w) => normalized.includes(w))
  );
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function splitUserText(input: string, maxItems: number): string[] {
  const parts = input
    .split(/[，,、；;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return (parts.length > 0 ? parts : [input.trim()]).slice(0, maxItems);
}

function normalizeTrait(input: string): string {
  const text = input.trim();
  if (text.includes("→")) return text;
  return `${text} → 因此在相关内容判断中会表现出这一倾向`;
}

function resolveAgeRange(input: string): string | null {
  const trimmed = input.trim();
  const num = parseInt(trimmed, 10);
  if (num >= 1 && num <= AGE_RANGE_OPTIONS.length) {
    return AGE_RANGE_OPTIONS[num - 1].value;
  }
  const exact = AGE_RANGE_OPTIONS.find((o) => o.value === trimmed);
  if (exact) return exact.value;
  const partial = AGE_RANGE_OPTIONS.find((o) => o.value.replace("岁", "") === trimmed);
  if (partial) return partial.value;
  return null;
}

function resolveAuthorRelation(input: string): string | null {
  const trimmed = input.trim();
  const num = parseInt(trimmed, 10);
  if (num === 1) return "已关注";
  if (num === 2) return "未关注";
  if (/已关注|关注了|已关/.test(trimmed)) return "已关注";
  if (/未关注|没关注|未关/.test(trimmed)) return "未关注";
  return null;
}

function inferCulturalContext(state: WizardState): string {
  const platform = state.fields.platform || "";
  if (/小红书|微信|公众号|知乎|B站|抖音/.test(platform)) {
    return "中国大陆互联网文化语境";
  }
  if (/Instagram|Reddit|YouTube|Twitter|X/.test(platform)) {
    return "海外互联网文化语境";
  }
  return "未提供";
}

function inferPersonaName(state: WizardState): string {
  const interest = state.fields.interests?.[0] || "内容";
  const platform = state.fields.platform || "通用";
  return `${platform}${interest}评论员`;
}

function stepNumber(state: WizardState): number {
  const order: WizardStep[] = [
    "ageRange",
    "interests",
    "traits",
    "platform",
    "authorRelation",
    "finalConfirm",
    "completed",
  ];
  return Math.max(1, order.indexOf(state.step) + 1);
}
