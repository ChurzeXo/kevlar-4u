/**
 * Get Execution Modes Tool
 * 
 * Query available execution modes and their current configuration status.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../utils/types.js";
import { getModesInfo } from "../execution/index.js";
import { readConfig } from "../execution/config.js";
import { hasApiKey } from "../execution/modes/direct_api.js";
import { isSamplingSupported, getCapabilitiesSummary } from "../execution/client.js";
import type { ToolModule } from "./types.js";

// ── Static Labels ──────────────────────────────────────────────────────────────

const MODE_LABELS: Record<string, { name: string; desc: string }> = {
  orchestration: {
    name: "宿主辅助兜底模式",
    desc: "单次 Prompt 交给宿主 AI 协助完成，零额外成本，但不是真正隔离的多智能体执行",
  },
  mcp_sampling: {
    name: "MCP 采样模式",
    desc: "真正并行执行，深度分析，需宿主客户端支持",
  },
  mcp_subagent: {
    name: "Subagent 并行调度模式",
    desc: "使用宿主 Task/Subagent 工具并行执行审计，零额外成本，真正隔离",
  },
  direct_api: {
    name: "直接 API 模式",
    desc: "需设置 KEVLAR_API_KEY 环境变量",
  },
};

const RECOMMENDED_LABELS: Record<string, string> = {
  orchestration: "宿主辅助兜底模式（零成本、低隔离 fallback）",
  mcp_sampling: "MCP 采样模式（推荐：并行深度分析）",
  mcp_subagent: "Subagent 并行调度模式（推荐：零成本 + 真隔离）",
  direct_api: "直接 API 模式（完全自主控制）",
};

// ── Tool Definition ────────────────────────────────────────────────────────────

export const getModesToolDefinition: Tool = {
  name: "get_execution_modes",
  description: "当用户问「当前模式/配置/可用模式」时，调用此工具。查询宿主辅助兜底、MCP 采样、直接 API 三种执行模式的可用性及当前配置状态。",
  inputSchema: { type: "object" as const, properties: {} },
};

export const getModesModule: ToolModule = {
  definition: getModesToolDefinition,
  handler: () => async () => await handleGetModes(),
};

// ── Handler ────────────────────────────────────────────────────────────────────

function formatStatus(mode: string, available: boolean): string {
  if (available) return "可用";
  return mode === "direct_api" ? "未配置" : "不可用";
}

function formatReason(
  mode: string,
  available: boolean,
  defaultDesc: string,
  apiKeyConfigured: boolean,
  samplingSupported: boolean,
): string {
  if (available) return defaultDesc;

  if (mode === "mcp_sampling" && !samplingSupported) {
    return "当前宿主客户端未在 initialize 中声明 sampling 能力。";
  }
  if (mode === "direct_api" && !apiKeyConfigured) {
    return "未配置 API Key。请设置 KEVLAR_API_KEY 环境变量。";
  }

  return defaultDesc;
}

export async function handleGetModes(): Promise<ToolResult> {
  try {
    const modesInfo = getModesInfo();
    const config = readConfig();
    const samplingSupported = isSamplingSupported();
    const apiKeyConfigured = hasApiKey();

    const rows = modesInfo.modes.map((m) => {
      const label = MODE_LABELS[m.mode] ?? { name: m.mode, desc: "" };
      const status = formatStatus(m.mode, m.available);
      const reason = formatReason(m.mode, m.available, label.desc, apiKeyConfigured, samplingSupported);
      return `| ${label.name} | ${status} | ${reason} |`;
    });

    const isFirstTime = config.createdAt === config.updatedAt;
    const firstTimeTip = isFirstTime
      ? `\n\n💡 首次使用？你可以告诉我"设置"来切换执行模式。`
      : "";

    const capsSummary = getCapabilitiesSummary();

    const text = [
      "**可用执行模式**",
      "",
      "| 模式 | 状态 | 说明 |",
      "|------|------|------|",
      ...rows,
      "",
      `**推荐模式**：${RECOMMENDED_LABELS[modesInfo.recommendedMode] ?? modesInfo.recommendedMode}`,
      `**当前配置**：${modesInfo.currentMode} → ${modesInfo.resolvedMode}`,
      `**客户端能力**：${capsSummary}`,
      ...(firstTimeTip ? [firstTimeTip] : []),
    ].join("\n");

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `获取模式信息失败：${message}` }],
      isError: true,
    };
  }
}
