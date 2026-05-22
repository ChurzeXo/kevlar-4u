/**
 * Get Execution Modes Tool
 * 
 * Query available execution modes and their current configuration status.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../utils/types.js";
import { getModesInfo } from "../execution/index.js";
import { readConfigAsync } from "../execution/config.js";
import { hasApiKey } from "../execution/modes/direct_api.js";
import { getSamplingClientList, isSamplingSupported } from "../execution/client.js";

export const getModesToolDefinition: Tool = {
  name: "get_execution_modes",
  description: "当用户问「当前模式/配置/可用模式」时，调用此工具。查询宿主辅助兜底、MCP 采样、直接 API 三种执行模式的可用性及当前配置状态。",
  inputSchema: { type: "object" as const, properties: {} },
};

export async function handleGetModes(): Promise<ToolResult> {
  const modesInfo = getModesInfo();
  const config = await readConfigAsync();
  const samplingClients = getSamplingClientList();
  const apiKeyConfigured = hasApiKey();

  const modeLabels: Record<string, { name: string; emoji: string; desc: string }> = {
    orchestration: {
      name: "宿主辅助兜底模式",
      emoji: "✅",
      desc: "单次 Prompt 交给宿主 AI 协助完成，零额外成本，但不是真正隔离的多智能体执行",
    },
    mcp_sampling: {
      name: "MCP 采样模式",
      emoji: "✅",
      desc: "真正并行执行，深度分析，需宿主客户端支持",
    },
    direct_api: {
      name: "直接 API 模式",
      emoji: apiKeyConfigured ? "✅" : "❌",
      desc: apiKeyConfigured
        ? "直接调用 LLM API，完全可控"
        : "需设置 KEVLAR_API_KEY 环境变量",
    },
  };

  // Build mode rows
  const rows = modesInfo.modes.map((m) => {
    const label = modeLabels[m.mode];
    let status = m.available ? "✅ 可用" : (m.mode === "direct_api" ? "❌ 未配置" : "❌ 不可用");
    let reason = label.desc;

    if (!m.available) {
      if (m.mode === "mcp_sampling" && !isSamplingSupported()) {
        reason = `当前宿主客户端不支持。支持的客户端：${samplingClients.join("、")}`;
      }
      if (m.mode === "direct_api" && !apiKeyConfigured) {
        reason = "未配置 API Key。请设置 KEVLAR_API_KEY 环境变量。";
      }
    }

    return `| ${label.name} | ${status} | ${reason} |`;
  });

  // Determine recommendation
  const recommendedLabels: Record<string, string> = {
    orchestration: "宿主辅助兜底模式（零成本、低隔离 fallback）",
    mcp_sampling: "MCP 采样模式（推荐：并行深度分析）",
    direct_api: "直接 API 模式（完全自主控制）",
  };

  const firstTimeTip = config.createdAt === config.updatedAt
    ? "\n\n💡 首次使用？你可以告诉我\"设置\"来切换执行模式。"
    : "";

  const text = `**可用执行模式**

| 模式 | 状态 | 说明 |
|------|------|------|
${rows.join("\n")}

**推荐模式**：${recommendedLabels[modesInfo.recommendedMode]}
**当前配置**：${modesInfo.currentMode} → ${modesInfo.resolvedMode}${firstTimeTip}`;

  return {
    content: [{ type: "text", text }],
  };
}
