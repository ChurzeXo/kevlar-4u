import { loadAllPersonas, Persona } from "../utils/parser.js";
import { ToolResult } from "../utils/types.js";
import { executeReview, loadPersonasForReview, MAX_PERSONAS } from "../execution/index.js";
import type { ExecutionContext, ResolveableMode, SamplingFunction } from "../execution/base.js";
import { getErrorInfo } from "../utils/observability.js";

// ── Resource limits ────────────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 100_000; // 100KB
const MAX_CONTEXT_LENGTH = 5_000; // 5KB

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

  // ── Load requested personas (or all of them) using unified helper ───────────
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
  }

  const loadResult = await loadPersonasForReview(skillsDir, input.persona_ids);
  personas = loadResult.personas;

  if (loadResult.missingIds && loadResult.missingIds.length > 0) {
    return {
      content: [
        {
          type: "text",
          text: `❌ 找不到以下评论员：${loadResult.missingIds.join(", ")}。请先查看可用评论员列表。`,
        },
      ],
      isError: true,
    };
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
  const allPersonas = await loadAllPersonas(skillsDir);
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
    const info = getErrorInfo(err);
    return {
      content: [
        {
          type: "text",
          text: `❌ 评测执行失败：${info.message}`,
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
