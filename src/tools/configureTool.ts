/**
 * Configure Tool
 * 
 * Write user preferences to kevlar-config.json.
 * Does NOT handle API keys - those come from environment variables only.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../utils/types.js";
import { updateConfig, isValidMode, isValidConcurrency } from "../execution/config.js";
import { logger } from "../utils/logger.js";

export const configureToolDefinition: Tool = {
  name: "configure",
  description:
    "【直接写入，无确认步骤】修改 Kevlar 运行配置（执行模式、并发数等持久化设置）。" +
    "推荐使用 configure_wizard 代替——它会先预览变更，用户确认后才写入。" +
    "仅在脚本或测试场景下直接调用本工具。",
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
        description: "最大并发数（仅 mcp_sampling / direct_api 模式生效）。不传则不修改。",
      },
    },
  },
};

export interface ConfigureInput {
  mode?: "auto" | "orchestration" | "mcp_sampling" | "direct_api";
  maxConcurrency?: number;
}

export async function handleConfigure(input: ConfigureInput): Promise<ToolResult> {
  // Validate mode
  if (input.mode !== undefined && !isValidMode(input.mode)) {
    return {
      content: [{ type: "text", text: `❌ 无效的执行模式：${input.mode}` }],
      isError: true,
    };
  }

  // Validate concurrency
  if (input.maxConcurrency !== undefined && !isValidConcurrency(input.maxConcurrency)) {
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

    const changesText = changes.length > 0 ? changes.join("、") : "（无变更）";

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

下次调用 review_content 时自动生效。`,
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `❌ 配置更新失败：${message}` }],
      isError: true,
    };
  }
}
