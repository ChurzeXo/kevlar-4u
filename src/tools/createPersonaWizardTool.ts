import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { ToolResult } from "../utils/types.js";
import { MultiTurnSamplingFunction } from "../execution/base.js";
import { WIZARD_SYSTEM_PROMPT } from "./createPersonaTool.js";
import { handleCreatePersona } from "./createPersonaTool.js";
import { logger } from "../utils/logger.js";

export const createPersonaWizardToolDefinition: Tool = {
  name: "create_persona_wizard",
  description: "使用 MCP Sampling 驱动的多轮对话引导用户创建高精度评论员人设。系统指令以 systemPrompt 级别注入，确保 AI 严格遵循角色构建流程。",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "当前向导对话的会话 ID（可选。若首次调用，请不要提供，系统会自动生成并返回新的 sessionId）"
      },
      userMessage: {
        type: "string",
        description: "用户的消息内容（如果是首次开始，可以传 '开始创建人设' 或者是您对人设的初步想法）"
      }
    },
    required: ["userMessage"]
  }
};

export interface WizardInput {
  sessionId?: string;
  userMessage: string;
  samplingFn?: MultiTurnSamplingFunction;
}

interface WizardState {
  sessionId: string;
  createdAt: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  status: "in_progress" | "completed";
}

export async function handleCreatePersonaWizard(
  skillsDir: string,
  tmpDir: string,
  input: WizardInput
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
            "2. 降级方案：您可以使用 Prompts 面板中的「虚拟读者人设搭建系统 (Create Persona Wizard)」Prompt 开启新对话来进行人设创建。"
          ].join("\n")
        }
      ],
      isError: true
    };
  }

  // 2. Resolve or generate sessionId
  const sessionId = inputSessionId || `wizard-create-${Math.random().toString(36).substring(2, 10)}`;
  const wizardStatePath = path.join(tmpDir, `${sessionId}_wizard.json`);

  // Ensure tmpDir exists
  if (!fs.existsSync(tmpDir)) {
    await fs.promises.mkdir(tmpDir, { recursive: true });
  }

  // 3. Load or initialize wizard state
  let state: WizardState = {
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
      logger.error("Failed to read wizard state", { event: "read_wizard_state_error", sessionId, error: String(err) });
    }
  }

  // Add the new user message to the conversation history
  state.messages.push({ role: "user", content: userMessage });

  // 4. Call Multi-turn Sampling API with true systemPrompt
  try {
    const samplingResponse = await samplingFn({
      systemPrompt: WIZARD_SYSTEM_PROMPT,
      messages: state.messages,
      maxTokens: 4096
    });

    const replyContent = samplingResponse.content;

    // Check if the wizard is complete
    const isComplete = replyContent.includes("===WIZARD_COMPLETE===");

    // Clean completion tag for display to user
    const displayReply = replyContent.replace("===WIZARD_COMPLETE===", "").trim();
    state.messages.push({ role: "assistant", content: displayReply });

    if (isComplete) {
      state.status = "completed";
      await fs.promises.writeFile(wizardStatePath, JSON.stringify(state, null, 2), "utf-8");

      // Trigger automatic extraction and creation
      logger.info("Create wizard detected complete marker. Triggering extraction.", { event: "wizard_complete", sessionId });
      return await executeAutomaticCreation(skillsDir, tmpDir, state, displayReply, samplingFn);
    }

    // Save ongoing state
    await fs.promises.writeFile(wizardStatePath, JSON.stringify(state, null, 2), "utf-8");

    return {
      content: [
        {
          type: "text",
          text: [
            displayReply,
            "",
            `🏷️ *[会话 ID: ${sessionId}] (继续对话请携为此 sessionId)*`
          ].join("\n")
        }
      ]
    };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Create persona wizard sampling error", { event: "wizard_sampling_error", sessionId, error: errorMsg });
    return {
      content: [{ type: "text", text: `❌ 交互采样过程失败：${errorMsg}` }],
      isError: true
    };
  }
}

async function executeAutomaticCreation(
  skillsDir: string,
  tmpDir: string,
  state: WizardState,
  displayReply: string,
  samplingFn: MultiTurnSamplingFunction
): Promise<ToolResult> {
  const sessionId = state.sessionId;
  const wizardStatePath = path.join(tmpDir, `${sessionId}_wizard.json`);
  const draftPath = path.join(tmpDir, `${sessionId}_draft.json`);

  try {
    // 1. Perform a secondary targeted sampling run to extract structured JSON fields
    const extractSystemPrompt = `你是一个高精度的 JSON 数据提取器。
你的唯一任务是阅读一段人设创建的多轮对话历史，提取并输出最终确认的四个字段及推断属性，以严格 JSON 格式输出。

输出 JSON 的结构：
{
  "name": "角色的中文名字",
  "ageRange": "角色的年龄段（例如：25-30岁，中年等）",
  "interests": ["兴趣1", "兴趣2", ...],
  "traits": ["特描述1 → 行为特质1", "特描述2 → 行为特质2", ...],
  "platform": "主要活跃的平台（如：小红书，知乎，B站等）",
  "culturalContext": "文化背景（模型推断或用户指定，如中国大陆年轻用户文化语境）",
  "authorRelation": "与作者的关系（模型推断或用户指定，如未关注/已关注）",
  "stance": "立场（模型推断或用户指定，如默认质疑/默认信任）",
  "blindSpot": "盲区（模型推断或用户指定，如无特定盲区或具体盲区）"
}

注意：
- 必须严格遵循 JSON 格式，输出必须以 { 开始，以 } 结束。
- 不要包含任何 markdown 标记（如 \`\`\`json）或任何说明性、前导/尾随文本。
- traits 中的每一项必须是 '性格特质 → 行为描述' 的格式，不能丢失 '→' 符号。
- 从对话历史中推断并补齐 culturalContext, authorRelation, stance, blindSpot 字段。`;

    const extractionResponse = await samplingFn({
      systemPrompt: extractSystemPrompt,
      messages: state.messages,
      maxTokens: 2048
    });

    let jsonText = extractionResponse.content.trim();
    // Strip markdown code fences if model returned them despite strict instructions
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
    }

    logger.debug("Extraction response", { event: "extraction_response", sessionId, jsonText });

    const extracted = JSON.parse(jsonText);

    // 2. Save to draft format
    const draftData = {
      sessionId,
      createdAt: Date.now(),
      step: 4,
      fields: {
        ageRange: extracted.ageRange,
        interests: extracted.interests,
        traits: extracted.traits,
        platform: extracted.platform,
        culturalContext: extracted.culturalContext,
        authorRelation: extracted.authorRelation,
        stance: extracted.stance,
        blindSpot: extracted.blindSpot
      }
    };

    await fs.promises.writeFile(draftPath, JSON.stringify(draftData, null, 2), "utf-8");

    // 3. Invoke handleCreatePersona to save the persona file
    const createResult = await handleCreatePersona(skillsDir, tmpDir, {
      name: extracted.name,
      sessionId,
      culturalContext: extracted.culturalContext,
      authorRelation: extracted.authorRelation,
      stance: extracted.stance,
      blindSpot: extracted.blindSpot
    });

    // 4. Clean up temporary files
    try {
      if (fs.existsSync(wizardStatePath)) await fs.promises.unlink(wizardStatePath);
      if (fs.existsSync(draftPath)) await fs.promises.unlink(draftPath);
    } catch (cleanErr) {
      logger.warn("Failed to clean up temporary wizard/draft files", { event: "cleanup_error", sessionId, error: String(cleanErr) });
    }

    if (createResult.isError) {
      return createResult;
    }

    return {
      content: [
        {
          type: "text",
          text: [
            displayReply,
            "",
            "✨ **人设创建完成！**",
            `已经根据对话内容为您成功创建人设「${extracted.name}」。`,
            "",
            "📄 **提取的人设参数如下：**",
            `- **名字**：${extracted.name}`,
            `- **年龄段**：${extracted.ageRange}`,
            `- **常用平台**：${extracted.platform}`,
            `- **兴趣方向**：${Array.isArray(extracted.interests) ? extracted.interests.join("、") : extracted.interests}`,
            `- **文化背景**：${extracted.culturalContext}`,
            `- **与作者的关系**：${extracted.authorRelation}`,
            `- **立场**：${extracted.stance}`,
            `- **盲区**：${extracted.blindSpot}`
          ].join("\n")
        }
      ]
    };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Failed in automatic creation flow", { event: "automatic_creation_error", sessionId, error: errorMsg });
    return {
      content: [
        {
          type: "text",
          text: [
            displayReply,
            "",
            "⚠️ 对话已收集完成，但在提取 JSON 字段或自动创建人设时发生错误。",
            `错误详情: ${errorMsg}`,
            `您的会话状态已保存在: ${sessionId}。您可以稍后尝试重新触发创建。`
          ].join("\n")
        }
      ],
      isError: true
    };
  }
}
