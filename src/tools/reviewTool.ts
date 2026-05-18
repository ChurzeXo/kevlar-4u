import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadAllPersonas, loadPersonasByIds, Persona } from "../utils/parser.js";
import { ToolResult } from "../utils/types.js";
import { executeReview, loadPersonasForReview } from "../execution/index.js";
import type { ExecutionContext, ResolveableMode, SamplingFunction } from "../execution/base.js";

// ── Resource limits ────────────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 100_000; // 100KB
const MAX_CONTEXT_LENGTH = 5_000; // 5KB
const MAX_PERSONAS = 50;

export const reviewToolDefinition: Tool = {
  name: "review_content",
  description:
    "将文案交给多个评论员进行压力测试。支持三种执行模式（编排代理/MCP采样/直接API）。使用前可先查看可用评论员让用户选择。",
  inputSchema: {
    type: "object" as const,
    properties: {
      content: {
        type: "string",
        description: "需要进行压力测试的文案、文章、剧本或任何文字内容",
      },
      persona_ids: {
        type: "array",
        items: { type: "string" },
        description: "用户选中的人设 ID。留空则使用全部角色。",
      },
      context: {
        type: "string",
        description:
          "可选：提供内容的发布平台和目标受众背景，帮助人设更精准地模拟目标用户",
      },
      mode: {
        type: "string",
        enum: ["auto", "orchestration", "mcp_sampling", "direct_api"],
        default: "auto",
        description: "执行模式。auto 会自动选择最佳模式。",
      },
    },
    required: ["content"],
  },
};

export interface ReviewInput {
  content: string;
  persona_ids?: string[];
  context?: string;
  mode?: ResolveableMode;
  samplingFn?: SamplingFunction;
}

export async function handleReviewContent(
  skillsDir: string,
  input: ReviewInput
): Promise<ToolResult> {
  // ── Resource limits validation ───────────────────────────────────────────
  if (!input.content || typeof input.content !== "string") {
    return {
      content: [{ type: "text", text: "❌ 请提供要评测的文案内容" }],
      isError: true,
    };
  }

  if (input.content.length > MAX_CONTENT_LENGTH) {
    return {
      content: [
        {
          type: "text",
          text: `❌ 文案内容超出长度限制（${MAX_CONTENT_LENGTH}字符）。当前长度：${input.content.length}字符`,
        },
      ],
      isError: true,
    };
  }

  if (input.context && input.context.length > MAX_CONTEXT_LENGTH) {
    return {
      content: [
        {
          type: "text",
          text: `❌ 上下文说明超出长度限制（${MAX_CONTEXT_LENGTH}字符）`,
        },
      ],
      isError: true,
    };
  }

  // ── Load all available personas (for continuation tracking) ──────────────
  const allPersonas = await loadAllPersonas(skillsDir);

  // ── Load requested personas (or all of them) ────────────────────────────
  let personas: Persona[];

  if (input.persona_ids && input.persona_ids.length > 0) {
    if (input.persona_ids.length > MAX_PERSONAS) {
      return {
        content: [
          {
            type: "text",
            text: `❌ 选择的评论员数量超出限制（最多${MAX_PERSONAS}个）`,
          },
        ],
        isError: true,
      };
    }

    personas = await loadPersonasByIds(skillsDir, input.persona_ids);

    const foundIds = new Set(personas.map((p) => p.meta.id));
    const missing = input.persona_ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return {
        content: [
          {
            type: "text",
            text: `❌ 找不到以下评论员：${missing.join(", ")}。请先查看可用评论员列表。`,
          },
        ],
        isError: true,
      };
    }
  } else {
    personas = allPersonas;
  }

  if (personas.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "⚠️ 当前没有可用评论员。请先创建自定义评论员。",
        },
      ],
      isError: true,
    };
  }

  // ── Track unselected personas for continuation flow ─────────────────────
  const activeIds = new Set(personas.map((p) => p.meta.id));
  const remainingPersonas = allPersonas.filter((p) => !activeIds.has(p.meta.id));

  // ── Execute review ─────────────────────────────────────────────────────
  const mode = input.mode || "auto";

  try {
    const ctx: ExecutionContext = {
      skillsDir,
      personas,
      content: input.content,
      context: input.context,
      samplingFn: input.samplingFn,
    };

    const result = await executeReview(mode, ctx);

    // Add continuation prompt if there are remaining personas
    const continuationNote = remainingPersonas.length > 0
      ? buildContinuationNote(remainingPersonas)
      : "";

    return {
      content: [
        {
          type: "text",
          text: result.report + continuationNote,
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `❌ 评测执行失败：${message}`,
        },
      ],
      isError: true,
    };
  }
}

function buildContinuationNote(remainingPersonas: Persona[]): string {
  const names = remainingPersonas.map((p) => p.meta.name).join("、");
  return `

---

## 🔄 延续测试

本轮有 **${remainingPersonas.length} 个人设未参与评测**：${names}。

**完成汇总报告后：**
1. 向用户展示报告
2. 询问是否要用剩余评论员（${names}）继续评测
3. 用户同意则启动新一轮评测（复用本次内容）
4. 用户拒绝则结束`;
}
