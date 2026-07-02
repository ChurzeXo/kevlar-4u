import { readConfig } from "../execution/config.js";
import { getLocalVersion } from "../utils/errorReporting.js";
import { logger } from "../utils/observability.js";
import type { ToolModule } from "./types.js";

async function handler(args: Record<string, unknown> | undefined): Promise<any> {
  const toolName = (args?.toolName ?? args?.tool ?? "unknown") as string;
  const errorCode = (args?.errorCode ?? args?.error_code ?? "UNKNOWN") as string;
  const errorMessage = (args?.errorMessage ?? args?.error_msg ?? "") as string;

  if (!toolName || !errorMessage) {
    return {
      content: [{ type: "text", text: "缺少必要参数：toolName 和 errorMessage 均为必填。" }],
      isError: true,
    };
  }

  const config = readConfig();
  const baseUrl = (config.cloud_server_url || "https://kevlar4u.xyz").replace(/\/+$/, "");
  const version = getLocalVersion();
  const platform = process.platform;
  const nodeVersion = process.version;

  try {
    const res = await fetch(`${baseUrl}/api/v1/error-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: toolName,
        errorCode,
        message: errorMessage,
        version,
        platform,
        nodeVersion,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      logger.warn("Error report submission failed", {
        event: "error_report_failed",
        status: res.status,
        tool: toolName,
      });
      return {
        content: [{ type: "text", text: "错误报告提交失败，请稍后重试。" }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text",
        text: "✅ 错误报告已匿名提交，感谢你的反馈！开发者会尽快排查。",
      }],
    };
  } catch (err) {
    logger.warn("Error report network error", {
      event: "error_report_network_error",
      error: (err as Error).message,
      tool: toolName,
    });
    return {
      content: [{ type: "text", text: "网络不可用，错误报告无法提交。请稍后重试。" }],
      isError: true,
    };
  }
}

export const submitErrorReportTool: ToolModule = {
  definition: {
    name: "submit_error_report",
    description:
      "提交错误报告到 kevlar-4u 开发团队。当工具返回错误且用户同意提交错误报告时调用。提交内容仅包含错误码和错误描述，不包含用户原始文案或个人信息。",
    inputSchema: {
      type: "object" as const,
      properties: {
        toolName: {
          type: "string",
          description: "出错的工具名称（如 review_content_wizard、review_content_wizard_continue 等）",
        },
        errorCode: {
          type: "string",
          description: "错误代码（如 INTERNAL_ERROR、VALIDATION_ERROR 等）",
        },
        errorMessage: {
          type: "string",
          description: "错误的简要描述信息",
        },
      },
      required: ["toolName", "errorMessage"],
    },
  },
  handler: () => handler,
};
