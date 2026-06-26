/**
 * Get Execution Modes Tool
 * 
 * Query available execution modes and their current configuration status.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../utils/types.js";
import { getModesInfo } from "../execution/index.js";
import { readConfig } from "../execution/config.js";
import { getCapabilitiesSummary } from "../execution/client.js";
import type { ToolModule } from "./types.js";

// ── Static Labels ──────────────────────────────────────────────────────────────

const MODE_LABELS: Record<string, { name: string; desc: string }> = {
  orchestration: {
    name: "宿主辅助兜底模式",
    desc: "单次 Prompt 交给宿主 AI 协助完成，零额外成本，使用标准模式",
  },
  mcp_subagent: {
    name: "Subagent 并行调度模式",
    desc: "使用宿主 Task/Subagent 工具自适应执行，零额外成本，支持结构化 Blueprint 协议",
  },
};

const RECOMMENDED_LABELS: Record<string, string> = {
  orchestration: "宿主辅助兜底模式（标准单体编排）",
  mcp_subagent: "Subagent 并行调度模式（推荐：结构化 Blueprint 协议）",
};

// ── Tool Definition ────────────────────────────────────────────────────────────

export const getModesToolDefinition: Tool = {
  name: "get_execution_modes",
  description: "当用户问「当前模式/配置/可用模式」时，调用此工具。查询宿主辅助兜底、Subagent 并行调度等执行模式的可用性及当前配置状态。",
  inputSchema: { type: "object" as const, properties: {} },
};

export const getModesModule: ToolModule = {
  definition: getModesToolDefinition,
  handler: () => async () => await handleGetModes(),
};

// ── Handler ────────────────────────────────────────────────────────────────────

export async function handleGetModes(): Promise<ToolResult> {
  try {
    const modesInfo = getModesInfo();
    const config = readConfig();

    const rows = modesInfo.modes.map((m) => {
      const label = MODE_LABELS[m.mode] ?? { name: m.mode, desc: "" };
      const status = m.available ? "可用" : "不可用";
      return `| ${label.name} | ${status} | ${label.desc} |`;
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
