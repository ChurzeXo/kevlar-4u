/**
 * Configure Tool
 *
 * Write user preferences to kevlar-config.json.
 * Does NOT handle API keys - those come from environment variables only.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../utils/types.js";
import type { ToolModule } from "./types.js";
import {
	updateConfig,
	isValidMode,
	isValidConcurrency,
} from "../execution/config.js";
import { logger, getErrorInfo } from "../utils/observability.js";

export const configureToolDefinition: Tool = {
	name: "configure",
	description:
		"直接修改 Kevlar 运行配置（执行模式、并发数等），改动即时写入 kevlar-config.json。" +
		"无需对话确认，适合明确的单次配置变更场景。" +
		"如需先预览再写入，请使用 configure_wizard。",
	inputSchema: {
		type: "object" as const,
		properties: {
			mode: {
				type: "string",
				enum: ["auto", "orchestration", "mcp_sampling", "direct_api"],
				description: "执行模式。不传则不修改当前值。",
			},
			maxConcurrency: {
				type: "number",
				minimum: 1,
				maximum: 10,
				description:
					"最大并发数（仅 mcp_sampling / direct_api 模式生效）。不传则不修改。",
			},
		},
	},
};

export interface ConfigureInput {
	mode?: "auto" | "orchestration" | "mcp_sampling" | "direct_api";
	maxConcurrency?: number;
}

export const configureModule: ToolModule = {
	definition: configureToolDefinition,
	handler: () => async (args) => {
		if (!args) throw new Error("配置需要提供参数");
		return await handleConfigure(args as ConfigureInput);
	},
};

export async function handleConfigure(
	input: ConfigureInput,
): Promise<ToolResult> {
	// Validate mode
	if (input.mode !== undefined && !isValidMode(input.mode)) {
		return {
			content: [{ type: "text", text: `❌ 无效的执行模式：${input.mode}` }],
			isError: true,
		};
	}

	// Validate concurrency
	if (
		input.maxConcurrency !== undefined &&
		!isValidConcurrency(input.maxConcurrency)
	) {
		return {
			content: [
				{
					type: "text",
					text: "❌ 并发数必须在 1-10 之间",
				},
			],
			isError: true,
		};
	}

	try {
		const updated = await updateConfig({
			mode: input.mode,
			maxConcurrency: input.maxConcurrency,
		});

		const changes: string[] = [];

		if (input.mode !== undefined) {
			const modeLabels: Record<string, string> = {
				auto: "自动",
				orchestration: "宿主辅助兜底模式",
				mcp_sampling: "MCP 采样模式",
				direct_api: "直接 API 模式",
			};
			changes.push(`执行模式：${modeLabels[input.mode]}`);
		}

		if (input.maxConcurrency !== undefined) {
			changes.push(`并发数：${input.maxConcurrency}`);
		}

		const changesText =
			changes.length > 0 ? changes.join("、") : "（无变更）";

		logger.info("Configuration updated via tool", {
			event: "configure_tool",
			mode: input.mode,
			maxConcurrency: input.maxConcurrency,
		});

		return {
			content: [
				{
					type: "text",
					text: `✅ 配置已更新
- ${changesText}

下次评测（review_content_wizard）时自动生效。`,
				},
			],
		};
	} catch (err) {
		const info = getErrorInfo(err);
		return {
			content: [{ type: "text", text: `❌ 配置更新失败：${info.message}` }],
			isError: true,
		};
	}
}
