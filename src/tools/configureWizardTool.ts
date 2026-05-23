import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import { handleConfigure, ConfigureInput } from "./configureTool.js";
import { isValidMode, isValidConcurrency } from "../execution/config.js";
import type { ToolModule } from "./types.js";
import { logger, getErrorInfo } from "../utils/observability.js";

export const configureWizardToolDefinition: Tool = {
	name: "configure_wizard",
	description:
		"当用户说「设置/配置/切换模式/改并发数」时，调用此工具。工具先预览配置变更，用户确认后才写入 kevlar-config.json。API Key 不由此工具处理，只能通过环境变量设置。",
	inputSchema: {
		type: "object",
		properties: {
			sessionId: {
				type: "string",
				description:
					"配置向导的会话标识。首次调用请留空，工具会自动生成并返回一个 sessionId。后续调用必须传入此值以继续上一次的配置会话。",
			},
			userMessage: {
				type: "string",
				description:
					"用户在当前步骤的回复内容。首次调用时传入用户原话（例如「切换到 MCP 采样模式」「并发数改成 5」），工具解析变更项并预览。后续步骤传入用户对工具提问的回复。",
			},
		},
		required: ["userMessage"],
	},
};

export interface ConfigureWizardInput {
	sessionId?: string;
	userMessage: string;
}

type ConfigureStep = "confirmConfigure" | "completed";

interface ConfigureWizardState {
	sessionId: string;
	createdAt: number;
	step: ConfigureStep;
	pending: ConfigureInput;
}

const CONFIRM_PHRASE = "确认修改配置";

export const configureWizardModule: ToolModule = {
	definition: configureWizardToolDefinition,
	handler: (deps) => async (args) => {
		if (!args) throw new Error("配置向导需要提供参数");
		return await handleConfigureWizard(deps.tmpDir, args as any);
	},
};

export async function handleConfigureWizard(
	tmpDir: string,
	input: ConfigureWizardInput,
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
			const pending = parseConfigRequest(input.userMessage);
			validatePending(pending);
			state.pending = pending;
			await saveState(tmpDir, state);
			return toolResponse(state, buildPreviewMessage(pending));
		}

		if (state.step === "completed") {
			return toolResponse(state, "这个配置修改流程已经完成。");
		}

		if (!normalize(input.userMessage).includes(normalize(CONFIRM_PHRASE))) {
			await saveState(tmpDir, state);
			return toolResponse(
				state,
				`请回复完整确认语「${CONFIRM_PHRASE}」后再写入配置。`,
			);
		}

		const result = await handleConfigure(state.pending);
		if (!result.isError) {
			state.step = "completed";
			await saveState(tmpDir, state);
			await cleanupState(tmpDir, state.sessionId);
		}
		return result;
	} catch (err) {
		const info = getErrorInfo(err);
		logger.error("Configure wizard failed", {
			event: "configure_wizard_error",
			error: info.code,
			message: info.message,
		});
		return {
			content: [{ type: "text", text: `❌ 配置向导失败：${info.message}` }],
			isError: true,
		};
	}
}

function parseConfigRequest(message: string): ConfigureInput {
	const normalized = message.toLowerCase();
	const pending: ConfigureInput = {};

	if (/direct[\s_-]*api|直接\s*api|直连/.test(normalized)) {
		pending.mode = "direct_api";
	} else if (/mcp[\s_-]*sampling|sampling|采样/.test(normalized)) {
		pending.mode = "mcp_sampling";
	} else if (/orchestration|编排|兜底|宿主辅助/.test(normalized)) {
		pending.mode = "orchestration";
	} else if (/auto|自动/.test(normalized)) {
		pending.mode = "auto";
	}

	const concurrencyMatch = normalized.match(
		/(?:并发|concurrency|maxconcurrency)\D*(10|[1-9])/,
	);
	if (concurrencyMatch) {
		pending.maxConcurrency = Number(concurrencyMatch[1]);
	}

	if (!pending.mode && pending.maxConcurrency === undefined) {
		throw new Error("没有识别到要修改的配置。请说明执行模式或并发数。");
	}

	return pending;
}

function validatePending(pending: ConfigureInput): void {
	if (pending.mode !== undefined && !isValidMode(pending.mode)) {
		throw new Error(`无效的执行模式：${pending.mode}`);
	}
	if (
		pending.maxConcurrency !== undefined &&
		!isValidConcurrency(pending.maxConcurrency)
	) {
		throw new Error("并发数必须在 1-10 之间");
	}
}

function buildPreviewMessage(pending: ConfigureInput): string {
	const lines = ["准备修改配置：", ""];
	if (pending.mode) {
		lines.push(`- 执行模式：${modeLabel(pending.mode)}`);
	}
	if (pending.maxConcurrency !== undefined) {
		lines.push(`- 并发数：${pending.maxConcurrency}`);
	}
	lines.push("");
	lines.push(`如确认写入配置，请回复：${CONFIRM_PHRASE}`);
	return lines.join("\n");
}

async function loadOrCreateState(
	tmpDir: string,
	input: ConfigureWizardInput,
): Promise<ConfigureWizardState> {
	if (input.sessionId && !/^[a-z0-9-]+$/.test(input.sessionId)) {
		throw new Error("sessionId 格式不合法。");
	}

	const sessionId =
		input.sessionId ||
		`wizard-configure-${Math.random().toString(36).substring(2, 10)}`;
	const statePath = getStatePath(tmpDir, sessionId);
	if (input.sessionId && fs.existsSync(statePath)) {
		const raw = await fs.promises.readFile(statePath, "utf-8");
		return JSON.parse(raw) as ConfigureWizardState;
	}

	return {
		sessionId,
		createdAt: Date.now(),
		step: "confirmConfigure",
		pending: {},
	};
}

async function saveState(
	tmpDir: string,
	state: ConfigureWizardState,
): Promise<void> {
	await fs.promises.mkdir(tmpDir, { recursive: true });
	const statePath = getStatePath(tmpDir, state.sessionId);
	const tmpPath = statePath + ".tmp";
	await fs.promises.writeFile(
		tmpPath,
		JSON.stringify(state, null, 2),
		"utf-8",
	);
	await fs.promises.rename(tmpPath, statePath);
}

async function cleanupState(tmpDir: string, sessionId: string): Promise<void> {
	const statePath = getStatePath(tmpDir, sessionId);
	try {
		if (fs.existsSync(statePath)) await fs.promises.unlink(statePath);
	} catch (err) {
		const info = getErrorInfo(err);
		logger.warn("Failed to clean configure wizard state", {
			event: "configure_wizard_cleanup_error",
			path: statePath,
			error: info.code,
			message: info.message,
		});
	}
}

function getStatePath(tmpDir: string, sessionId: string): string {
	return path.join(tmpDir, `${sessionId}_configure_wizard.json`);
}

function toolResponse(
	state: ConfigureWizardState,
	assistantMessage: string,
): ToolResult {
	return {
		content: [
			{
				type: "text",
				text: [
					assistantMessage,
					"",
					"```kevlar-state",
					`sessionId: ${state.sessionId}`,
					"workflow: configure",
					`currentStep: ${state.step}`,
					state.pending.mode
						? `pendingMode: ${state.pending.mode}`
						: undefined,
					state.pending.maxConcurrency !== undefined
						? `pendingMaxConcurrency: ${state.pending.maxConcurrency}`
						: undefined,
					"```",
				]
					.filter(Boolean)
					.join("\n"),
			},
		],
	};
}

function modeLabel(mode: NonNullable<ConfigureInput["mode"]>): string {
	const labels: Record<NonNullable<ConfigureInput["mode"]>, string> = {
		auto: "自动",
		orchestration: "宿主辅助兜底模式",
		mcp_sampling: "MCP 采样模式",
		direct_api: "直接 API 模式",
	};
	return labels[mode];
}

function normalize(input: string): string {
	return input.replace(/\s+/g, "").toLowerCase();
}
