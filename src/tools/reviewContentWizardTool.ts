import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import { MultiTurnSamplingFunction } from "../execution/base.js";
import { loadAllPersonas, Persona } from "../utils/parser.js";
import { handleReviewContent } from "./reviewTool.js";
import { logger } from "../utils/logger.js";

export const reviewContentWizardToolDefinition: Tool = {
  name: "review_content_wizard",
  description:
    "推进一个由 Kevlar 服务端维护状态的内容评测工作流。工具会保存待测内容、检查角色库、推荐或展示评论员，并且只在用户确认后执行评测。",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description:
          "当前评测向导会话 ID。首次调用不传；继续会话时必须带回工具返回的 sessionId。",
      },
      userMessage: {
        type: "string",
        description:
          "用户在当前评测工作流步骤下的回复。首次调用时传入待评测内容或评测请求。",
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
  | "checkPersonaInventory"
  | "waitingForPersonaCreation"
  | "confirmSelection"
  | "completed";

interface ReviewWizardState {
  sessionId: string;
  createdAt: number;
  step: ReviewWizardStep;
  content: string;
  context?: string;
  selectedPersonaIds: string[];
  remainingPersonaIds: string[];
}

interface Recommendation {
  personaIds: string[];
  assistantMessage: string;
}

export async function handleReviewContentWizard(
  skillsDir: string,
  tmpDir: string,
  input: ReviewWizardInput
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
    const personas = await loadAllPersonas(skillsDir);
    return await advanceWizard(skillsDir, tmpDir, state, personas, input.userMessage, input.samplingFn);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Review content wizard failed", { event: "review_wizard_error", error: message });
    return {
      content: [{ type: "text", text: `❌ 内容评测向导失败：${message}` }],
      isError: true,
    };
  }
}

async function advanceWizard(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string,
  samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  switch (state.step) {
    case "checkPersonaInventory":
      return handleInventoryCheck(tmpDir, state, personas, samplingFn);

    case "waitingForPersonaCreation":
      return handleInventoryCheck(tmpDir, state, personas, samplingFn);

    case "confirmSelection":
      return handleSelectionConfirmation(skillsDir, tmpDir, state, personas, userMessage);

    case "completed":
      return toolResponse(state, "这个评测流程已经完成。需要评测新内容时，请重新开始一个会话。");
  }
}

async function handleInventoryCheck(
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  samplingFn?: MultiTurnSamplingFunction
): Promise<ToolResult> {
  if (personas.length === 0) {
    state.step = "waitingForPersonaCreation";
    state.selectedPersonaIds = [];
    state.remainingPersonaIds = [];
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        "当前还没有可用评论员。请先创建至少一个角色，再继续这次内容评测。",
        "",
        "我已经暂存了本次待评测内容；创建角色后，带上这个 sessionId 再次调用 review_content_wizard 即可继续。",
      ].join("\n")
    );
  }

  if (personas.length <= 2) {
    state.step = "confirmSelection";
    state.selectedPersonaIds = personas.map((p) => p.meta.id);
    state.remainingPersonaIds = [];
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        `当前只有 ${personas.length} 位评论员可用，已为你展示全部角色，请确认是否使用。`,
        "",
        ...personas.map((p) => `- ${p.meta.name} (ID: ${p.meta.id}) · ${p.meta.tags.join("、") || "所有平台"} · ${p.meta.description}`),
        "",
        "确认使用以上评论员吗？",
      ].join("\n")
    );
  }

  const recommendation = await recommendPersonas(state, personas, samplingFn);
  const selected = personas.filter((p) => recommendation.personaIds.includes(p.meta.id));
  state.step = "confirmSelection";
  state.selectedPersonaIds = selected.map((p) => p.meta.id);
  state.remainingPersonaIds = personas
    .filter((p) => !state.selectedPersonaIds.includes(p.meta.id))
    .map((p) => p.meta.id);
  await saveState(tmpDir, state);

  return toolResponse(state, recommendation.assistantMessage);
}

async function handleSelectionConfirmation(
  skillsDir: string,
  tmpDir: string,
  state: ReviewWizardState,
  personas: Persona[],
  userMessage: string
): Promise<ToolResult> {
  const explicitIds = extractPersonaIds(userMessage, personas);
  if (explicitIds.length > 0) {
    state.selectedPersonaIds = explicitIds;
    state.remainingPersonaIds = personas
      .filter((p) => !explicitIds.includes(p.meta.id))
      .map((p) => p.meta.id);
    await saveState(tmpDir, state);
    const selectedNames = personas
      .filter((p) => explicitIds.includes(p.meta.id))
      .map((p) => p.meta.name)
      .join("、");
    return toolResponse(state, `已选择：${selectedNames}。确认开始评测吗？`);
  }

  if (!isAffirmative(userMessage)) {
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        "请告诉我你想使用哪些评论员。可以直接回复评论员 ID 或名称。",
        "",
        ...personas.map((p) => `- ${p.meta.name} (ID: ${p.meta.id}) · ${p.meta.description}`),
      ].join("\n")
    );
  }

  if (state.selectedPersonaIds.length === 0) {
    throw new Error("当前没有已选择的评论员。");
  }

  const reviewResult = await handleReviewContent(skillsDir, {
    content: state.content,
    persona_ids: state.selectedPersonaIds,
    context: state.context,
    mode: "auto",
  });

  if (reviewResult.isError) {
    return {
      content: [{ type: "text", text: reviewResult.content[0]?.text || "❌ 评测执行失败。" }],
      isError: true,
    };
  }

  state.step = "completed";
  await saveState(tmpDir, state);
  await cleanupState(tmpDir, state.sessionId);
  return reviewResult;
}

async function recommendPersonas(
  state: ReviewWizardState,
  personas: Persona[],
  samplingFn?: MultiTurnSamplingFunction
): Promise<Recommendation> {
  if (samplingFn) {
    try {
      const personaSummary = personas.map((p) => ({
        id: p.meta.id,
        name: p.meta.name,
        tags: p.meta.tags,
        description: p.meta.description,
      }));
      const response = await samplingFn({
        systemPrompt:
          "你是 Kevlar 评论员推荐器。根据待评测内容和角色列表推荐 1-3 个最合适的 persona id，并严格输出 JSON：{\"personaIds\":[\"id\"],\"assistantMessage\":\"展示推荐名单和理由，并询问用户是否确认\"}。不要输出 markdown。",
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              content: state.content,
              context: state.context || "",
              personas: personaSummary,
            }),
          },
        ],
        maxTokens: 2048,
      });
      const parsed = JSON.parse(stripCodeFence(response.content.trim())) as Record<string, unknown>;
      const validIds = new Set(personas.map((p) => p.meta.id));
      const personaIds = Array.isArray(parsed.personaIds)
        ? parsed.personaIds.map(String).filter((id) => validIds.has(id)).slice(0, 3)
        : [];
      if (personaIds.length > 0 && typeof parsed.assistantMessage === "string") {
        return { personaIds, assistantMessage: parsed.assistantMessage };
      }
    } catch (err) {
      logger.warn("AI persona recommendation failed, falling back to heuristic", {
        event: "review_recommendation_fallback",
        error: String(err),
      });
    }
  }

  return heuristicRecommendation(state, personas);
}

function heuristicRecommendation(state: ReviewWizardState, personas: Persona[]): Recommendation {
  const terms = `${state.content}\n${state.context || ""}`.toLowerCase();
  const scored = personas
    .map((p) => {
      const haystack = [p.meta.name, p.meta.description, ...p.meta.tags, p.systemPrompt].join("\n").toLowerCase();
      const score = p.meta.tags.reduce((sum, tag) => sum + (terms.includes(tag.toLowerCase()) ? 2 : 0), 0) +
        (terms.includes(p.meta.name.toLowerCase()) ? 3 : 0) +
        (haystack.includes("小红书") && terms.includes("小红书") ? 1 : 0);
      return { persona: p, score };
    })
    .sort((a, b) => b.score - a.score);

  const selected = scored.slice(0, Math.min(3, personas.length)).map((item) => item.persona);
  return {
    personaIds: selected.map((p) => p.meta.id),
    assistantMessage: [
      "我为这篇内容推荐了以下评论员：",
      "",
      ...selected.map((p) => `- ${p.meta.name}（推荐理由：标签和描述与本次内容更接近；ID: ${p.meta.id}）`),
      "",
      "确认使用以上评论员，还是需要从完整列表中自选？",
    ].join("\n"),
  };
}

async function loadOrCreateState(tmpDir: string, input: ReviewWizardInput): Promise<ReviewWizardState> {
  if (input.sessionId && !/^[a-z0-9-]+$/.test(input.sessionId)) {
    throw new Error("sessionId 格式不合法。");
  }

  const sessionId = input.sessionId || `wizard-review-${Math.random().toString(36).substring(2, 10)}`;
  const statePath = getStatePath(tmpDir, sessionId);

  if (input.sessionId && fs.existsSync(statePath)) {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    return JSON.parse(raw) as ReviewWizardState;
  }

  return {
    sessionId,
    createdAt: Date.now(),
    step: "checkPersonaInventory",
    content: input.userMessage.trim(),
    selectedPersonaIds: [],
    remainingPersonaIds: [],
  };
}

async function saveState(tmpDir: string, state: ReviewWizardState): Promise<void> {
  await fs.promises.mkdir(tmpDir, { recursive: true });
  await fs.promises.writeFile(getStatePath(tmpDir, state.sessionId), JSON.stringify(state, null, 2), "utf-8");
}

async function cleanupState(tmpDir: string, sessionId: string): Promise<void> {
  const statePath = getStatePath(tmpDir, sessionId);
  try {
    if (fs.existsSync(statePath)) await fs.promises.unlink(statePath);
  } catch (err) {
    logger.warn("Failed to clean review wizard state", {
      event: "review_wizard_cleanup_error",
      path: statePath,
      error: String(err),
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
          `selectedPersonaIds: ${state.selectedPersonaIds.join(", ") || "none"}`,
          `remainingPersonaIds: ${state.remainingPersonaIds.join(", ") || "none"}`,
          "```",
        ].join("\n"),
      },
    ],
  };
}

function extractPersonaIds(input: string, personas: Persona[]): string[] {
  const selected: string[] = [];
  for (const persona of personas) {
    const idMatch = input.includes(persona.meta.id);
    // For very short names (≤2 chars), require exact match to prevent false positives
    // e.g. persona named "好" should not match "这篇不好"
    const nameMatch =
      persona.meta.name.length > 2
        ? input.includes(persona.meta.name)
        : input.trim() === persona.meta.name;
    if (idMatch || nameMatch) {
      selected.push(persona.meta.id);
    }
  }
  return selected;
}

function isAffirmative(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  // Short/ambiguous words require exact match to avoid false positives.
  // e.g. "这是什么" contains "是" but should NOT be treated as affirmative.
  const exactMatchWords = ["是", "对", "好", "y"];
  const containsMatchWords = ["确认", "可以", "没问题", "开始", "执行", "ok", "yes"];
  return (
    exactMatchWords.some((w) => normalized === w) ||
    containsMatchWords.some((w) => normalized.includes(w))
  );
}

function stripCodeFence(text: string): string {
  if (!text.startsWith("```")) return text;
  return text.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
}
