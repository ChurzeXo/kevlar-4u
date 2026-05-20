import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import { MultiTurnSamplingFunction } from "../execution/base.js";
import { REVIEW_DISPATCHER_PROMPT } from "../prompts/reviewDispatcherPrompt.js";
import { loadAllPersonas } from "../utils/parser.js";
import { handleReviewContent } from "./reviewTool.js";
import { logger } from "../utils/logger.js";

export const WIZARD_REVIEW_DISPATCHER_PROMPT = `${REVIEW_DISPATCHER_PROMPT}

---

## 五、系统对接协议（仅限内部使用，不对用户展示）

当用户同意你推荐的评论员组合（或指定了他自选的评论员）并且你准备启动评测时，
请在你的回复最后一行，以严格 JSON 格式输出以下执行标记（不要包含任何 markdown 标记如 \`\`\`json）：

===EXECUTE_REVIEW=== { "persona_ids": ["id1", "id2"], "content": "待评论的完整内容", "context": "发布平台或受众背景（可选）" }

注意：
- 该 JSON 中的 content 必须是用户最开始提交的、需要评测的完整文案内容。
- 如果没有明确提供 context，context 字段可以设为 ""。
- ===EXECUTE_REVIEW=== 标记与其后的 JSON 必须独占一行，前后不得有其他文本。`;

export const reviewContentWizardToolDefinition: Tool = {
  name: "review_content_wizard",
  description: "使用 MCP Sampling 驱动的评测调度向导。引导用户匹配评论员，并在确认后自动执行高精度评论并生成诊断报告。",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "当前向导对话的会话 ID（可选。若首次调用，请不要提供，系统会自动生成并返回新的 sessionId）"
      },
      userMessage: {
        type: "string",
        description: "用户的消息内容（如果是首次开始，可以输入您需要评测的内容或者请求匹配评论员）"
      }
    },
    required: ["userMessage"]
  }
};

export interface ReviewWizardInput {
  sessionId?: string;
  userMessage: string;
  samplingFn?: MultiTurnSamplingFunction;
}

interface ReviewWizardState {
  sessionId: string;
  createdAt: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  status: "in_progress" | "completed";
}

export async function handleReviewContentWizard(
  skillsDir: string,
  tmpDir: string,
  input: ReviewWizardInput
): Promise<ToolResult> {
  const { sessionId: inputSessionId, userMessage, samplingFn } = input;

  // 1. Check if Sampling is available
  if (!samplingFn) {
    return {
      content: [
        {
          type: "text",
          text: [
            "❌ 您的客户端目前不支持或未启用 MCP Sampling（采样）能力。",
            "",
            "**解决办法：**",
            "1. 请在您的 MCP 客户端设置中开启 'Sampling' / '采样模型' 能力。",
            "2. 降级方案：您可以使用 Prompts 面板中的「内容评测调度引擎 (Content Review Dispatcher)」Prompt 开启新对话来进行匹配和评测。"
          ].join("\n")
        }
      ],
      isError: true
    };
  }

  // 2. Resolve or generate sessionId
  const sessionId = inputSessionId || `wizard-review-${Math.random().toString(36).substring(2, 10)}`;
  const wizardStatePath = path.join(tmpDir, `${sessionId}_review_wizard.json`);

  // Ensure tmpDir exists
  if (!fs.existsSync(tmpDir)) {
    await fs.promises.mkdir(tmpDir, { recursive: true });
  }

  // 3. Load or initialize wizard state
  let state: ReviewWizardState = {
    sessionId,
    createdAt: Date.now(),
    messages: [],
    status: "in_progress"
  };

  if (inputSessionId && fs.existsSync(wizardStatePath)) {
    try {
      const data = await fs.promises.readFile(wizardStatePath, "utf-8");
      state = JSON.parse(data);
    } catch (err) {
      logger.error("Failed to read review wizard state", { event: "read_wizard_state_error", sessionId, error: String(err) });
    }
  }

  // Add the new user message to the conversation history
  state.messages.push({ role: "user", content: userMessage });

  // 4. Inject dynamic available personas context in a copy of the message list
  const activePersonas = await loadAllPersonas(skillsDir);
  const personaListStr = activePersonas
    .map(p => `- ${p.meta.name} (ID: ${p.meta.id}, 平台: ${p.meta.tags.join("、") || "所有"}, 简介: ${p.meta.description})`)
    .join("\n");

  const systemInject = `\n\n【系统补充：当前库中已有的可用评论员列表如下：\n${personaListStr}\n\n当前人设总数量为：${activePersonas.length}。如果没有可用角色，请在第一步引导创建人设前，通过系统提示词中描述的流程记录并暂存用户的待测文案。】`;

  // Clone messages to inject dynamic context without polluting persistent session file
  const samplingMessages = state.messages.map((m, idx) => {
    if (idx === state.messages.length - 1 && m.role === "user") {
      return { ...m, content: m.content + systemInject };
    }
    return m;
  });

  // 5. Call Multi-turn Sampling API with true systemPrompt
  try {
    const samplingResponse = await samplingFn({
      systemPrompt: WIZARD_REVIEW_DISPATCHER_PROMPT,
      messages: samplingMessages,
      maxTokens: 4096
    });

    const replyContent = samplingResponse.content;

    // Check if review execution was triggered
    const executeMarker = "===EXECUTE_REVIEW===";
    const hasExecutionTrigger = replyContent.includes(executeMarker);

    if (hasExecutionTrigger) {
      const parts = replyContent.split(executeMarker);
      const displayReply = parts[0].trim();
      const jsonPayloadStr = parts[1].trim();

      state.messages.push({ role: "assistant", content: displayReply });
      state.status = "completed";
      await fs.promises.writeFile(wizardStatePath, JSON.stringify(state, null, 2), "utf-8");

      logger.info("Review wizard triggered evaluation execution.", { event: "review_wizard_complete", sessionId });

      return await executeAutomaticReview(skillsDir, wizardStatePath, displayReply, jsonPayloadStr);
    }

    // Regular dialogue flow
    state.messages.push({ role: "assistant", content: replyContent });
    await fs.promises.writeFile(wizardStatePath, JSON.stringify(state, null, 2), "utf-8");

    return {
      content: [
        {
          type: "text",
          text: [
            replyContent,
            "",
            `🏷️ *[会话 ID: ${sessionId}] (继续对话请携带此 sessionId)*`
          ].join("\n")
        }
      ]
    };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Review content wizard sampling error", { event: "wizard_sampling_error", sessionId, error: errorMsg });
    return {
      content: [{ type: "text", text: `❌ 交互采样过程失败：${errorMsg}` }],
      isError: true
    };
  }
}

async function executeAutomaticReview(
  skillsDir: string,
  wizardStatePath: string,
  displayReply: string,
  jsonPayloadStr: string
): Promise<ToolResult> {
  try {
    let jsonText = jsonPayloadStr.trim();
    // Strip markdown code fences if model returned them
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
    }

    const payload = JSON.parse(jsonText);
    const { persona_ids, content, context } = payload;

    if (!content) {
      throw new Error("Missing content in execution payload");
    }

    // Call standard review handler
    const reviewResult = await handleReviewContent(skillsDir, {
      content,
      persona_ids,
      context: context || undefined,
      mode: "auto" // Automatically resolves optimal execution mode
    });

    // Clean up session state upon successful completion
    try {
      if (fs.existsSync(wizardStatePath)) {
        await fs.promises.unlink(wizardStatePath);
      }
    } catch (cleanErr) {
      logger.warn("Failed to clean up review wizard state file", { event: "cleanup_error", path: wizardStatePath, error: String(cleanErr) });
    }

    if (reviewResult.isError) {
      return {
        content: [
          {
            type: "text",
            text: [
              displayReply,
              "",
              "❌ 评测执行失败：",
              reviewResult.content[0].text
            ].join("\n")
          }
        ],
        isError: true
      };
    }

    return {
      content: [
        {
          type: "text",
          text: [
            displayReply,
            "",
            reviewResult.content[0].text
          ].join("\n")
        }
      ]
    };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Failed to execute automatic review from wizard", { event: "automatic_review_error", error: errorMsg, payload: jsonPayloadStr });
    return {
      content: [
        {
          type: "text",
          text: [
            displayReply,
            "",
            "⚠️ 已收到评测确认，但在执行评测任务时发生解析或运行错误。",
            `错误详情: ${errorMsg}`
          ].join("\n")
        }
      ],
      isError: true
    };
  }
}
