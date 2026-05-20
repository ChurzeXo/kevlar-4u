import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import { ToolResult } from "../utils/types.js";
import { handleResetPersonas } from "./resetPersonasTool.js";
import { logger } from "../utils/logger.js";

export const resetPersonasWizardToolDefinition: Tool = {
  name: "reset_personas_wizard",
  description:
    "推进一个由 Kevlar 服务端维护状态的默认人设恢复工作流。工具会先展示影响范围，并要求用户回复完整确认语后才执行批量恢复。",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "当前恢复向导会话 ID。首次调用不传；继续确认时必须带回工具返回的 sessionId。",
      },
      userMessage: {
        type: "string",
        description: "用户在当前恢复工作流步骤下的回复。",
      },
    },
    required: ["userMessage"],
  },
};

export interface ResetPersonasWizardInput {
  sessionId?: string;
  userMessage: string;
}

type ResetPersonasStep = "confirmReset" | "completed";

interface ResetPersonasWizardState {
  sessionId: string;
  createdAt: number;
  step: ResetPersonasStep;
}

const CONFIRM_PHRASE = "确认恢复默认评论员";

export async function handleResetPersonasWizard(
  skillsDir: string,
  tmpDir: string,
  input: ResetPersonasWizardInput
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
    if (!input.sessionId) {
      await saveState(tmpDir, state);
      return toolResponse(
        state,
        [
          "将恢复系统内置默认评论员。",
          "这会重新创建或覆盖内置角色文件；自定义角色不会被删除。",
          "",
          `如确认执行，请回复：${CONFIRM_PHRASE}`,
        ].join("\n")
      );
    }

    if (state.step === "completed") {
      return toolResponse(state, "默认人设恢复流程已经完成。");
    }

    if (!normalize(input.userMessage).includes(normalize(CONFIRM_PHRASE))) {
      await saveState(tmpDir, state);
      return toolResponse(state, `请回复完整确认语「${CONFIRM_PHRASE}」后再执行恢复。`);
    }

    const result = await handleResetPersonas(skillsDir, { confirm: true });
    if (!result.isError) {
      state.step = "completed";
      await saveState(tmpDir, state);
      await cleanupState(tmpDir, state.sessionId);
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Reset personas wizard failed", { event: "reset_wizard_error", error: message });
    return {
      content: [{ type: "text", text: `❌ 默认人设恢复向导失败：${message}` }],
      isError: true,
    };
  }
}

async function loadOrCreateState(
  tmpDir: string,
  input: ResetPersonasWizardInput
): Promise<ResetPersonasWizardState> {
  if (input.sessionId && !/^[a-z0-9-]+$/.test(input.sessionId)) {
    throw new Error("sessionId 格式不合法。");
  }

  const sessionId = input.sessionId || `wizard-reset-${Math.random().toString(36).substring(2, 10)}`;
  const statePath = getStatePath(tmpDir, sessionId);
  if (input.sessionId && fs.existsSync(statePath)) {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    return JSON.parse(raw) as ResetPersonasWizardState;
  }

  return {
    sessionId,
    createdAt: Date.now(),
    step: "confirmReset",
  };
}

async function saveState(tmpDir: string, state: ResetPersonasWizardState): Promise<void> {
  await fs.promises.mkdir(tmpDir, { recursive: true });
  await fs.promises.writeFile(getStatePath(tmpDir, state.sessionId), JSON.stringify(state, null, 2), "utf-8");
}

async function cleanupState(tmpDir: string, sessionId: string): Promise<void> {
  const statePath = getStatePath(tmpDir, sessionId);
  try {
    if (fs.existsSync(statePath)) await fs.promises.unlink(statePath);
  } catch (err) {
    logger.warn("Failed to clean reset wizard state", {
      event: "reset_wizard_cleanup_error",
      path: statePath,
      error: String(err),
    });
  }
}

function getStatePath(tmpDir: string, sessionId: string): string {
  return path.join(tmpDir, `${sessionId}_reset_wizard.json`);
}

function toolResponse(state: ResetPersonasWizardState, assistantMessage: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          assistantMessage,
          "",
          "```kevlar-state",
          `sessionId: ${state.sessionId}`,
          "workflow: reset_personas",
          `currentStep: ${state.step}`,
          "```",
        ].join("\n"),
      },
    ],
  };
}

function normalize(input: string): string {
  return input.replace(/\s+/g, "").toLowerCase();
}
