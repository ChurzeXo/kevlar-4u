import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import { MultiTurnSamplingFunction } from "../execution/base.js";
import { handleCreatePersona } from "./createPersonaTool.js";
import { logger } from "../utils/logger.js";

export const createPersonaWizardToolDefinition: Tool = {
  name: "create_persona_wizard",
  description:
    "推进一个由 Kevlar 服务端维护状态的人设创建工作流。每次调用会根据 session 状态返回唯一下一步问题、确认请求或创建结果；宿主 AI 应展示 assistantMessage，并在用户回复后继续调用本工具。",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description:
          "当前向导对话的会话 ID（可选。若首次调用，请不要提供，系统会自动生成并返回新的 sessionId）",
      },
      userMessage: {
        type: "string",
        description:
          "用户在当前工作流步骤下的回复。首次开始可以传 '开始创建人设'。",
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
  | "ageRangeConfirm"
  | "interests"
  | "interestsConfirm"
  | "traits"
  | "traitsConfirm"
  | "platform"
  | "platformConfirm"
  | "finalConfirm"
  | "completed";

type DraftField = "ageRange" | "interests" | "traits" | "platform";

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
  pendingField?: DraftField;
  pendingValue?: string | string[];
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
        "请问这个角色的年龄段是？例如：18-24岁、30-35岁。"
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
    case "ageRange":
      return setPendingAndAskForConfirmation(tmpDir, state, "ageRange", userMessage.trim(), "ageRangeConfirm");

    case "ageRangeConfirm":
      return handleConfirmation(tmpDir, state, userMessage, {
        confirmedStep: "interests",
        retryStep: "ageRange",
        nextMessage: "请描述这个角色的兴趣方向，可以自由描述，不需要使用特定格式。",
        retryMessage: "请重新告诉我这个角色的年龄段。",
      });

    case "interests": {
      const extracted = await extractInterests(userMessage, samplingFn);
      return setPendingAndAskForConfirmation(
        tmpDir,
        state,
        "interests",
        extracted.value,
        "interestsConfirm",
        extracted.assistantMessage
      );
    }

    case "interestsConfirm":
      return handleConfirmation(tmpDir, state, userMessage, {
        confirmedStep: "traits",
        retryStep: "interests",
        nextMessage: "请描述这个角色的性格特质，可以自由描述，不需要使用特定格式。",
        retryMessage: "请重新描述这个角色的兴趣方向。",
      });

    case "traits": {
      const extracted = await extractTraits(userMessage, samplingFn);
      return setPendingAndAskForConfirmation(
        tmpDir,
        state,
        "traits",
        extracted.value,
        "traitsConfirm",
        extracted.assistantMessage
      );
    }

    case "traitsConfirm":
      return handleConfirmation(tmpDir, state, userMessage, {
        confirmedStep: "platform",
        retryStep: "traits",
        nextMessage:
          "请问这个角色主要用于评论哪个平台的内容？例如：微信公众号、小红书、Instagram、Twitter/X、YouTube、Reddit。",
        retryMessage: "请重新描述这个角色的性格特质。",
      });

    case "platform":
      return setPendingAndAskForConfirmation(
        tmpDir,
        state,
        "platform",
        userMessage.trim(),
        "platformConfirm"
      );

    case "platformConfirm":
      return handleConfirmation(tmpDir, state, userMessage, {
        confirmedStep: "finalConfirm",
        retryStep: "platform",
        nextMessage: buildFinalConfirmationMessage(state),
        retryMessage: "请重新告诉我这个角色主要用于评论哪个平台的内容。",
      });

    case "finalConfirm":
      if (!isAffirmative(userMessage)) {
        state.step = "platform";
        state.pendingField = undefined;
        state.pendingValue = undefined;
        await saveState(tmpDir, state);
        return toolResponse(state, "好的。请告诉我需要修改的平台，或重新输入常用平台。");
      }
      return completeWizard(skillsDir, tmpDir, state, samplingFn);

    case "completed":
      return toolResponse(state, "这个人设创建流程已经完成。需要创建新角色时，请重新开始一个会话。");
  }
}

async function setPendingAndAskForConfirmation(
  tmpDir: string,
  state: WizardState,
  field: DraftField,
  value: string | string[],
  nextStep: WizardStep,
  assistantMessage?: string
): Promise<ToolResult> {
  state.pendingField = field;
  state.pendingValue = value;
  state.step = nextStep;
  await saveState(tmpDir, state);

  return toolResponse(
    state,
    assistantMessage || buildConfirmationMessage(field, value)
  );
}

async function handleConfirmation(
  tmpDir: string,
  state: WizardState,
  userMessage: string,
  options: {
    confirmedStep: WizardStep;
    retryStep: WizardStep;
    nextMessage: string;
    retryMessage: string;
  }
): Promise<ToolResult> {
  if (!isAffirmative(userMessage)) {
    state.step = options.retryStep;
    state.pendingField = undefined;
    state.pendingValue = undefined;
    await saveState(tmpDir, state);
    return toolResponse(state, options.retryMessage);
  }

  if (!state.pendingField || state.pendingValue === undefined) {
    throw new Error("当前会话缺少待确认字段。");
  }

  (state.fields as Record<string, string | string[]>)[state.pendingField] = state.pendingValue;
  state.pendingField = undefined;
  state.pendingValue = undefined;
  state.step = options.confirmedStep;
  await saveState(tmpDir, state);
  await saveDraft(tmpDir, state);

  return toolResponse(state, options.nextMessage);
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
    const json = await runJsonExtraction(samplingFn, {
      systemPrompt:
        "你是字段提炼器。请把用户对兴趣方向的自然语言描述提炼为最多 3 个中文短标签，并严格输出 JSON：{\"interests\":[\"标签\"],\"assistantMessage\":\"确认话术\"}。不要输出 markdown。",
      userMessage,
    });
    const interests = normalizeStringArray(json.interests).slice(0, 3);
    if (interests.length > 0) {
      return {
        value: interests,
        assistantMessage:
          typeof json.assistantMessage === "string"
            ? json.assistantMessage
            : `我帮你总结为以下标签：${interests.join("、")}。确认没问题吗？如需调整请直接告诉我。`,
      };
    }
  }

  const interests = splitUserText(userMessage, 3);
  return {
    value: interests,
    assistantMessage: `我帮你总结为以下标签：${interests.join("、")}。确认没问题吗？如需调整请直接告诉我。`,
  };
}

async function extractTraits(
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ExtractionResult> {
  if (samplingFn) {
    const json = await runJsonExtraction(samplingFn, {
      systemPrompt:
        "你是字段提炼器。请把用户对性格特质的自然语言描述提炼为最多 4 条「特质 → 行为描述」字符串，并严格输出 JSON：{\"traits\":[\"特质 → 因此当 X 时，会 Y\"],\"assistantMessage\":\"确认话术\"}。不要输出 markdown。",
      userMessage,
    });
    const traits = normalizeStringArray(json.traits).slice(0, 4).map(normalizeTrait);
    if (traits.length > 0) {
      return {
        value: traits,
        assistantMessage:
          typeof json.assistantMessage === "string"
            ? json.assistantMessage
            : `我帮你总结为以下性格特质：\n${traits.map((t) => `- ${t}`).join("\n")}\n确认没问题吗？如需调整请直接告诉我。`,
      };
    }
  }

  const traits = splitUserText(userMessage, 4).map(normalizeTrait);
  return {
    value: traits,
    assistantMessage: `我帮你总结为以下性格特质：\n${traits.map((t) => `- ${t}`).join("\n")}\n确认没问题吗？如需调整请直接告诉我。`,
  };
}

async function inferFinalFields(
  state: WizardState,
  samplingFn?: MultiTurnSamplingFunction
): Promise<Pick<WizardState["fields"], "culturalContext" | "authorRelation" | "stance" | "blindSpot">> {
  const fallback = {
    culturalContext: inferCulturalContext(state),
    authorRelation: "未关注",
    stance: "默认质疑",
    blindSpot: "无特定盲区",
  };

  if (!samplingFn) return fallback;

  try {
    const json = await runJsonExtraction(samplingFn, {
      systemPrompt:
        "你是人设属性推断器。根据已确认字段推断 culturalContext、authorRelation、stance、blindSpot，并严格输出 JSON：{\"culturalContext\":\"...\",\"authorRelation\":\"...\",\"stance\":\"...\",\"blindSpot\":\"...\"}。不要输出 markdown。",
      userMessage: JSON.stringify(state.fields),
    });
    return {
      culturalContext: typeof json.culturalContext === "string" ? json.culturalContext : fallback.culturalContext,
      authorRelation: typeof json.authorRelation === "string" ? json.authorRelation : fallback.authorRelation,
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
          state.pendingField ? `pendingField: ${state.pendingField}` : undefined,
          "```",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  };
}

function buildConfirmationMessage(field: DraftField, value: string | string[]): string {
  const rendered = Array.isArray(value) ? value.join("、") : value;
  const labels: Record<DraftField, string> = {
    ageRange: "年龄段",
    interests: "兴趣方向",
    traits: "性格特质",
    platform: "常用平台",
  };
  if (field === "traits" && Array.isArray(value)) {
    return `我帮你总结为以下内容：\n性格特质：\n${value.map((item) => `- ${item}`).join("\n")}\n确认没问题吗？如需调整请直接告诉我。`;
  }
  return `${labels[field]}：${rendered}，确认没问题吗？`;
}

function buildFinalConfirmationMessage(state: WizardState): string {
  const fields = state.fields;
  return [
    "所有信息已收集完毕，确认没有问题的话，我就开始创建角色了。",
    "",
    `年龄段：${fields.ageRange || ""}`,
    `兴趣方向：${fields.interests?.join("、") || ""}`,
    `常用平台：${fields.platform || ""}`,
    "性格特质：",
    ...(fields.traits || []).map((trait) => `- ${trait}`),
  ].join("\n");
}

function isAffirmative(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return ["确认", "是", "可以", "没问题", "对", "好", "ok", "yes", "y"].some((word) =>
    normalized.includes(word)
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
    "ageRangeConfirm",
    "interests",
    "interestsConfirm",
    "traits",
    "traitsConfirm",
    "platform",
    "platformConfirm",
    "finalConfirm",
    "completed",
  ];
  return Math.max(1, order.indexOf(state.step) + 1);
}
