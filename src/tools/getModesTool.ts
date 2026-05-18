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
  description: "查询当前可用的执行模式及配置状态。用于查看三种评测模式（编排代理/MCP采样/直接API）的可用性。",
  inputSchema: { type: "object" as const, properties: {} },
};

export async function handleGetModes(): Promise<ToolResult> {
  const modesInfo = getModesInfo();
  const config = await readConfigAsync();
  const samplingClients = getSamplingClientList();
  const apiKeyConfigured = hasApiKey();

  const modeLabels: Record<string, { name: string; emoji: string; desc: string }> = {
    orchestration: {
      name: "编排代理模式",
      emoji: "✅",
      desc: "单次 Prompt 调用，简单可靠，零 Token 成本",
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
    orchestration: "编排代理模式（零成本开箱即用）",
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
