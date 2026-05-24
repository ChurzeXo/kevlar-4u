import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import type { MultiTurnSamplingFunction } from "../execution/base.js";
import type { ToolModule } from "./types.js";
import {
  handleCreatePersona,
  generateIdFromDraft,
  getSubDirFromDraft,
  applyDedup,
} from "./createPersonaTool.js";
import { logger, getErrorInfo } from "../utils/observability.js";

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
    "当用户说「创建/新建/自定义评论员/人设/角色」时，调用此工具。首次调用不带 sessionId，将 userMessage 设为用户的原话；工具会引导用户逐步完成年龄段、兴趣方向、性格特质、讲话语气、常用平台、与作者关系等信息收集。完全独立，不涉及内容评测流程。",
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
  | "tone"
  | "platform"
  | "authorRelation"
  | "finalConfirm"
  | "completed";

type DraftField = "ageRange" | "interests" | "traits" | "tone" | "platform" | "authorRelation" | "name" | "gender";

interface WizardState {
  sessionId: string;
  createdAt: number;
  step: WizardStep;
  fields: {
    ageRange?: string;
    interests?: string[];
    traits?: string[];
    tone?: string[];
    platform?: string;
    platformNote?: string;
    culturalContext?: string;
    authorRelation?: string;
    stance?: string;
    blindSpot?: string;
    personaName?: string;
    gender?: string;
  };
}

interface ExtractionResult {
  value: string | string[];
  assistantMessage: string;
}

export const createPersonaWizardModule: ToolModule = {
  definition: createPersonaWizardToolDefinition,
  handler: (deps) => async (args) => {
    if (!args) throw new Error("向导需要提供参数");
    const input = args as any;
    if (deps.updateClientSamplingSupport()) {
      input.samplingFn = deps.createMultiTurnSamplingFn();
    }
    return await handleCreatePersonaWizard(deps.skillsDir, deps.tmpDir, input);
  },
};

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
    const info = getErrorInfo(err);
    logger.error("Create persona wizard failed", { event: "wizard_error", error: info.code, message: info.message });
    return {
      content: [{ type: "text", text: `❌ 人设创建向导失败：${info.message}` }],
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
          "第二步：告诉我这个角色的日常兴趣与关注焦点？",
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
      state.step = "tone";
      await saveState(tmpDir, state);
      await saveDraft(tmpDir, state);
      return toolResponse(
        state,
        [
          extracted.assistantMessage,
          "",
          "第四步：请描述这个角色的讲话语气",
          "自由描述即可，例如：毒舌犀利、温柔耐心、幽默风趣、一本正经……",
        ].join("\n")
      );
    }

    case "tone": {
      const toneExtracted = await extractTone(userMessage, samplingFn);
      state.fields.tone = normalizeStringArray(toneExtracted.value);
      state.step = "platform";
      await saveState(tmpDir, state);
      await saveDraft(tmpDir, state);
      return toolResponse(
        state,
        [
          toneExtracted.assistantMessage,
          "",
          "第五步：内容主要投放平台",
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
          state.fields.platformNote = `⚠️ 你输入了多个平台，将围绕「${first}」创建此评论员。如需覆盖其他平台，请另行创建。`;
          state.step = "authorRelation";
          await saveState(tmpDir, state);
          await saveDraft(tmpDir, state);
          return toolResponse(
            state,
            [
              `已记录常用平台：${state.fields.platform}`,
              state.fields.platformNote,
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

      // Infer name, gender, culturalContext, stance, blindSpot before showing preview
      const inferred = await inferFinalFields(state, skillsDir, samplingFn);
      state.fields = { ...state.fields, ...inferred };

      state.step = "finalConfirm";
      await saveState(tmpDir, state);
      await saveDraft(tmpDir, state);
      return toolResponse(state, buildFinalConfirmationMessage(state, skillsDir));
    }

    case "finalConfirm":
      if (isAffirmative(userMessage)) {
        return completeWizard(skillsDir, tmpDir, state, samplingFn);
      }

      {
        const modified = await applyFinalModification(state, userMessage, samplingFn);
        if (!modified) {
          return toolResponse(state, "请说明要修改哪个字段：名字、性别、年龄段、兴趣方向、性格特质或常用平台。");
        }
        await saveState(tmpDir, state);
        await saveDraft(tmpDir, state);
        return toolResponse(
          state,
          [`已更新${fieldLabel(modified)}。`, "", buildFinalConfirmationMessage(state, skillsDir)].join("\n")
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
    case "name":
      state.fields.personaName = valueText;
      break;
    case "gender":
      state.fields.gender = valueText === "男" || valueText === "女" ? valueText : "未指定";
      break;
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
    case "tone": {
      const extracted = await extractTone(valueText, samplingFn);
      state.fields.tone = normalizeStringArray(extracted.value);
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
  _samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  state.step = "completed";
  await saveState(tmpDir, state);
  await saveDraft(tmpDir, state);

  const createResult = await handleCreatePersona(skillsDir, tmpDir, {
    name: state.fields.personaName || inferPersonaName(state),
    sessionId: state.sessionId,
    culturalContext: state.fields.culturalContext,
    authorRelation: state.fields.authorRelation,
    stance: state.fields.stance,
    blindSpot: state.fields.blindSpot,
    gender: state.fields.gender,
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
          "你是字段提炼器。请把用户对兴趣方向的自然语言描述提炼为最多 3 个中文短标签，并严格输出 JSON：{\"interests\":[\"标签\"],\"assistantMessage\":\"整理说明\"}。assistantMessage 可自由给出贴合场景的引导性举例辅助说明，再总结标签。不要要求用户确认。不要输出 markdown。",
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
      const info = getErrorInfo(err);
      logger.warn("Sampling extraction failed for interests, falling back to heuristic", {
        event: "sampling_interests_fallback",
        error: info.code,
        message: info.message,
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
      const info = getErrorInfo(err);
      logger.warn("Sampling extraction failed for traits, falling back to heuristic", {
        event: "sampling_traits_fallback",
        error: info.code,
        message: info.message,
      });
    }
  }

  const traits = splitUserText(userMessage, 4).map(normalizeTrait);
  return {
    value: traits,
    assistantMessage: `我帮你总结为以下性格特质：\n${traits.map((t) => `- ${t}`).join("\n")}`,
  };
}

async function extractTone(
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ExtractionResult> {
  if (samplingFn) {
    try {
      const json = await runJsonExtraction(samplingFn, {
        systemPrompt:
          "你是字段提炼器。请把用户对讲话语气的自然语言描述提炼为最多 4 个中文短标签（每个标签是独立描述，简洁自然），并严格输出 JSON：{\"tone\":[\"标签\"],\"assistantMessage\":\"整理说明\"}。assistantMessage 只说明已总结的语气特点，不要要求用户确认。不要输出 markdown。",
        userMessage,
      });
      const tone = normalizeStringArray(json.tone).slice(0, 4);
      if (tone.length > 0) {
        return {
          value: tone,
          assistantMessage:
            typeof json.assistantMessage === "string"
              ? sanitizeStepAssistantMessage(json.assistantMessage)
              : `我帮你总结为以下讲话特点：\n${tone.map((t) => `- ${t}`).join("\n")}`,
        };
      }
    } catch (err) {
      const info = getErrorInfo(err);
      logger.warn("Sampling extraction failed for tone, falling back to heuristic", {
        event: "sampling_tone_fallback",
        error: info.code,
        message: info.message,
      });
    }
  }

  const tone = splitUserText(userMessage, 4);
  return {
    value: tone,
    assistantMessage: `我帮你总结为以下讲话特点：\n${tone.map((t) => `- ${t}`).join("\n")}`,
  };
}

async function inferFinalFields(
  state: WizardState,
  skillsDir: string,
  samplingFn?: MultiTurnSamplingFunction
): Promise<Pick<WizardState["fields"], "culturalContext" | "authorRelation" | "stance" | "blindSpot" | "personaName" | "gender">> {
  const interest = state.fields.interests?.[0] || "内容";

  const fallback = {
    culturalContext: inferCulturalContext(state),
    authorRelation: state.fields.authorRelation || "未关注",
    stance: "默认质疑",
    blindSpot: "无特定盲区",
    personaName: inferPersonaName(state),
    gender: "未指定",
  };

  const platformRefs = loadPlatformStanceBlindSpotRefs(state, skillsDir);

  if (!samplingFn) return fallback;

  try {
    const json = await runJsonExtraction(samplingFn, {
      systemPrompt: [
        "你是人设属性推断器。根据已确认字段推断以下字段，必须全部填写，不能为空：",
        "- personaName：有创意、像真实互联网网名，不要带「评论员」后缀，也不要带平台名",
        "- gender：男 / 女 / 未指定",
        "- culturalContext",
        "- stance：该角色看问题的基本立场（参考同平台已有角色的风格，但不要照搬）",
        "- blindSpot：该角色因自身局限可能忽略的视角（参考同平台已有角色的风格，但不要照搬）",
        platformRefs ? `\n同平台已有人设参考：\n${platformRefs}` : "",
        `\n严格输出 JSON：{"personaName":"...","gender":"...","culturalContext":"...","stance":"...","blindSpot":"..."}`,
        "authorRelation 已由用户明确选择，不要覆盖。不要输出 markdown。",
      ].filter(Boolean).join("\n"),
      userMessage: JSON.stringify(state.fields),
    });
    return {
      personaName: typeof json.personaName === "string" && json.personaName.trim().length > 0
        ? json.personaName.trim()
        : fallback.personaName,
      gender: typeof json.gender === "string" && (json.gender === "男" || json.gender === "女")
        ? json.gender
        : "未指定",
      culturalContext: typeof json.culturalContext === "string" ? json.culturalContext : fallback.culturalContext,
      authorRelation: fallback.authorRelation,
      stance: typeof json.stance === "string" && json.stance.trim().length > 0 ? json.stance.trim() : fallback.stance,
      blindSpot: typeof json.blindSpot === "string" && json.blindSpot.trim().length > 0 ? json.blindSpot.trim() : fallback.blindSpot,
    };
  } catch {
    return fallback;
  }
}

function loadPlatformStanceBlindSpotRefs(state: WizardState, skillsDir: string): string {
  const subDir = getSubDirFromDraft({ fields: state.fields });
  if (!subDir) return "";
  const dir = path.join(skillsDir, subDir);
  try {
    if (!fs.statSync(dir).isDirectory()) return "";
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".md") && f !== "_template.md");
    if (files.length === 0) return "";

    const refs: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      const nameMatch = content.match(/^name:\s*(.+)/m);
      const stanceMatch = content.match(/^stance:\s*(.+)/m);
      const blindSpotMatch = content.match(/^blindSpot:\s*(.+)/m);
      const name = nameMatch ? nameMatch[1].trim() : file.replace(".md", "");
      const stance = stanceMatch ? stanceMatch[1].trim() : "（未设置）";
      const blindSpot = blindSpotMatch ? blindSpotMatch[1].trim() : "（未设置）";
      refs.push(`- ${name}：立场="${stance}"，盲区="${blindSpot}"`);
    }
    return refs.join("\n");
  } catch {
    return "";
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
  const statePath = getStatePath(tmpDir, state.sessionId);
  const tmpPath = statePath + ".tmp";
  await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  await fs.promises.rename(tmpPath, statePath);
}

async function saveDraft(tmpDir: string, state: WizardState): Promise<void> {
  const draft = {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    step: stepNumber(state),
    fields: state.fields,
  };
  const draftPath = getDraftPath(tmpDir, state.sessionId);
  const tmpPath = draftPath + ".tmp";
  await fs.promises.writeFile(tmpPath, JSON.stringify(draft, null, 2), "utf-8");
  await fs.promises.rename(tmpPath, draftPath);
}

async function cleanupState(tmpDir: string, sessionId: string): Promise<void> {
  for (const filePath of [getStatePath(tmpDir, sessionId), getDraftPath(tmpDir, sessionId)]) {
    try {
      if (fs.existsSync(filePath)) await fs.promises.unlink(filePath);
    } catch (err) {
      const info = getErrorInfo(err);
      logger.warn("Failed to clean wizard file", { event: "wizard_cleanup_error", path: filePath, error: info.code, message: info.message });
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

function buildFinalConfirmationMessage(state: WizardState, skillsDir: string): string {
  const fields = state.fields;

  // Build a preview of the persona file that will be created
  const previewDraft = { fields };
  const subDir = getSubDirFromDraft(previewDraft);

  const baseId =
    generateIdFromDraft(previewDraft) ||
    inferPersonaName(state).replace(/[^a-zA-Z0-9_]/g, "").toLowerCase() ||
    `persona_${Math.random().toString(36).substring(2, 8)}`;

  const id = applyDedup(skillsDir, baseId, subDir);

  const personaName = fields.personaName || inferPersonaName(state);

  const culturalContext = fields.culturalContext || "未提供";
  const authorRelation = fields.authorRelation || "未关注";
  const stance = fields.stance || "默认质疑";
  const blindSpot = fields.blindSpot || "无特定盲区";
  const gender = fields.gender || undefined;

  const lines: string[] = [
    "基本信息：",
    `角色名：${personaName}`,
    `ID：${id}`,
    `年龄段：${fields.ageRange || ""}`,
  ];
  if (gender) lines.push(`性别：${gender}`);
  lines.push(
    `兴趣方向：${Array.isArray(fields.interests) ? fields.interests.join("、") : ""}`,
    `常用平台：${fields.platform || ""}`,
    `文化背景：${culturalContext}`,
    `立场：${stance}`,
    `盲区：${blindSpot}`,
    "性格特质：",
  );
  if (Array.isArray(fields.traits)) {
    fields.traits.forEach((t: string) => lines.push(`  ${t}`));
  }
  lines.push("讲话语气：");
  if (Array.isArray(fields.tone)) {
    fields.tone.forEach((t: string) => lines.push(`  ${t}`));
  }
  lines.push(`与作者关系：${authorRelation}`);

  if (fields.platformNote) {
    lines.push("", fields.platformNote);
  }

  lines.push(
    "",
    "如需修改，请直接说：名字改成... / 性别改成... / 年龄段改成... / 兴趣方向改成... / 性格特质改成... / 讲话语气改成... / 平台改成... / 关系改成...",
    "确认无误请回复：确认创建",
  );

  return lines.join("\n");
}

function detectModifiedField(input: string): DraftField | undefined {
  if (/名字|名|名称|角色名|称呼/.test(input)) return "name";
  if (/性别|男|女/.test(input)) return "gender";
  if (/年龄|年龄段|\d+\s*[-到至]\s*\d+\s*岁|岁/.test(input)) return "ageRange";
  if (/兴趣|方向|标签/.test(input)) return "interests";
  if (/性格|特质|脾气|行为/.test(input)) return "traits";
  if (/语气|讲话|说话|口吻/.test(input)) return "tone";
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
    name: /名字|名|名称|角色名|称呼/g,
    gender: /性别/g,
    ageRange: /年龄段?|岁数?/g,
    interests: /兴趣方向|兴趣|方向|标签/g,
    traits: /性格特质|性格|特质|脾气|行为/g,
    tone: /讲话语气|语气|讲话|说话|口吻/g,
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
    name: "名字",
    gender: "性别",
    ageRange: "年龄段",
    interests: "兴趣方向",
    traits: "性格特质",
    tone: "讲话语气",
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
  return interest;
}

function stepNumber(state: WizardState): number {
  const order: WizardStep[] = [
    "ageRange",
    "interests",
    "traits",
    "tone",
    "platform",
    "authorRelation",
    "finalConfirm",
    "completed",
  ];
  return Math.max(1, order.indexOf(state.step) + 1);
}
