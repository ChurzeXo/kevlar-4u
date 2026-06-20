import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import type { MultiTurnSamplingFunction } from "../execution/base.js";
import type { ToolModule } from "./types.js";
import {
  handleDeletePersona,
} from "./deletePersonaTool.js";
import { loadAllPersonas, Persona } from "../utils/parser.js";
import { logger, getErrorInfo } from "../utils/observability.js";
import { isValidSessionId } from "../utils/sessionId.js";

export const deletePersonaWizardToolDefinition: Tool = {
  name: "delete_persona_wizard",
  description:
    "当用户说「删除/移除评审员/人设」时，调用此工具（评论区模拟器中的删除功能）。工具自动列出所有评审员供匹配，绑定目标后会要求用户回复完整人设名称以二次确认。用户未明确说出待删除角色名称时不会执行。",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "删除向导的会话标识。首次调用请留空，工具会自动生成并返回一个 sessionId。后续调用必须传入此值以继续上一次的删除会话。",
      },
      userMessage: {
        type: "string",
        description: "用户在当前步骤的回复内容。首次调用时直接传入用户原话（例如「删除急性子路人甲」），工具自动匹配目标。后续步骤传入用户对工具提问的回复。",
      },
    },
    required: ["userMessage"],
  },
};

export interface DeletePersonaWizardInput {
  sessionId?: string;
  userMessage: string;
}

type DeletePersonaStep = "selectPersona" | "confirmDelete" | "completed";

interface DeletePersonaWizardState {
  sessionId: string;
  createdAt: number;
  step: DeletePersonaStep;
  targetPersonaId?: string;
  targetPersonaName?: string;
}

export const deletePersonaWizardModule: ToolModule = {
  definition: deletePersonaWizardToolDefinition,
  handler: (deps) => async (args) => {
    if (!args) throw new Error("删除向导需要提供参数");
    return await handleDeletePersonaWizard(deps.skillsDir, deps.tmpDir, args as any);
  },
};

export async function handleDeletePersonaWizard(
  skillsDir: string,
  tmpDir: string,
  input: DeletePersonaWizardInput
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
    return await advanceDeleteWizard(skillsDir, tmpDir, state, personas, input.userMessage);
  } catch (err) {
    const info = getErrorInfo(err);
    logger.error("Delete persona wizard failed", { event: "delete_wizard_error", error: info.code, message: info.message });
    return {
      content: [{ type: "text", text: `❌ 人设删除向导失败：${info.message}` }],
      isError: true,
    };
  }
}

async function advanceDeleteWizard(
  skillsDir: string,
  tmpDir: string,
  state: DeletePersonaWizardState,
  personas: Persona[],
  userMessage: string
): Promise<ToolResult> {
  switch (state.step) {
    case "selectPersona":
      return selectPersona(tmpDir, state, personas, userMessage);

    case "confirmDelete":
      return confirmDelete(skillsDir, tmpDir, state, userMessage);

    case "completed":
      return toolResponse(state, "这个删除流程已经完成。需要删除其他人设时，请重新开始一个会话。");
  }
}

async function selectPersona(
  tmpDir: string,
  state: DeletePersonaWizardState,
  personas: Persona[],
  userMessage: string
): Promise<ToolResult> {
  if (personas.length === 0) {
    await saveState(tmpDir, state);
    return toolResponse(state, "当前没有可删除的人设。");
  }

  const matches = matchPersonas(userMessage, personas);
  if (matches.length !== 1) {
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      [
        matches.length > 1 ? "找到了多个可能的人设，请明确要删除哪一个。" : "我没有找到明确匹配的人设，请从列表中选择要删除的对象。",
        "",
        ...personas.map((p) => `- ${p.meta.name} (ID: ${p.meta.id}) · ${p.meta.description}`),
      ].join("\n")
    );
  }

  const persona = matches[0];
  state.step = "confirmDelete";
  state.targetPersonaId = persona.meta.id;
  state.targetPersonaName = persona.meta.name;
  await saveState(tmpDir, state);

  return toolResponse(
    state,
    [
      `将删除人设「${persona.meta.name}」（ID: ${persona.meta.id}）。`,
      "这是不可逆的文件删除操作。",
      "",
      `如确认删除，请回复：确认删除${persona.meta.name}`,
    ].join("\n")
  );
}

async function confirmDelete(
  skillsDir: string,
  tmpDir: string,
  state: DeletePersonaWizardState,
  userMessage: string
): Promise<ToolResult> {
  if (!state.targetPersonaId || !state.targetPersonaName) {
    throw new Error("当前会话缺少已绑定的删除目标。");
  }

  const required = `确认删除${state.targetPersonaName}`;
  if (!normalize(userMessage).includes(normalize(required))) {
    await saveState(tmpDir, state);
    return toolResponse(
      state,
      `请回复完整确认语「${required}」后再执行删除。`
    );
  }

  const result = await handleDeletePersona(skillsDir, {
    id: state.targetPersonaId,
    confirm: true,
  });

  if (!result.isError) {
    state.step = "completed";
    await saveState(tmpDir, state);
    await cleanupState(tmpDir, state.sessionId);
  }

  return result;
}

function matchPersonas(userMessage: string, personas: Persona[]): Persona[] {
  const normalizedInput = normalize(userMessage);
  return personas.filter((persona) => {
    return (
      normalizedInput.includes(normalize(persona.meta.id)) ||
      normalizedInput.includes(normalize(persona.meta.name))
    );
  });
}

async function loadOrCreateState(
  tmpDir: string,
  input: DeletePersonaWizardInput
): Promise<DeletePersonaWizardState> {
  if (input.sessionId && !isValidSessionId(input.sessionId)) {
    throw new Error("sessionId 格式不合法。");
  }

  const sessionId = input.sessionId || `wizard-delete-${Math.random().toString(36).substring(2, 10)}`;
  const statePath = getStatePath(tmpDir, sessionId);
  if (input.sessionId && fs.existsSync(statePath)) {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    return JSON.parse(raw) as DeletePersonaWizardState;
  }

  return {
    sessionId,
    createdAt: Date.now(),
    step: "selectPersona",
  };
}

async function saveState(tmpDir: string, state: DeletePersonaWizardState): Promise<void> {
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
    logger.warn("Failed to clean delete wizard state", {
      event: "delete_wizard_cleanup_error",
      path: statePath,
      error: info.code,
      message: info.message,
    });
  }
}

function getStatePath(tmpDir: string, sessionId: string): string {
  return path.join(tmpDir, `${sessionId}_delete_wizard.json`);
}

function toolResponse(state: DeletePersonaWizardState, assistantMessage: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          assistantMessage,
          "",
          "```kevlar-state",
          `sessionId: ${state.sessionId}`,
          "workflow: delete_persona",
          `currentStep: ${state.step}`,
          state.targetPersonaId ? `targetPersonaId: ${state.targetPersonaId}` : undefined,
          state.targetPersonaName ? `targetPersonaName: ${state.targetPersonaName}` : undefined,
          "```",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  };
}

function normalize(input: string): string {
  return input.replace(/\s+/g, "").toLowerCase();
}
