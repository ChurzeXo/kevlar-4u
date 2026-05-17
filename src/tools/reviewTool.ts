import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadAllPersonas, loadPersonasByIds, Persona } from "../utils/parser.js";

// 统一返回类型定义
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

export const reviewToolDefinition: Tool = {
  name: "review_content",
  description:
    "核心功能：将文案交给多个独立的批评人设进行压力测试。使用前先展示可用评论员让用户选择（默认全选）。评测完成后如有未参与的评论员，应询问用户是否延续测试。",
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
        description:
          "用户选中的人设 ID。留空则使用全部角色。",
      },
      context: {
        type: "string",
        description:
          "可选：提供内容的发布平台和目标受众背景，帮助人设更精准地模拟目标用户，例如：「微信公众号，目标读者是25-35岁职场女性」",
      },
    },
    required: ["content"],
  },
};

export interface ReviewInput {
  content: string;
  persona_ids?: string[];
  context?: string;
}

/**
 * Build the orchestration prompt that instructs the host model (Claude Desktop / Cursor)
 * to spawn independent sub-agent threads, one per persona.
 *
 * Kevlar itself has zero token cost — it dispatches work to the client's active model.
 */
export async function handleReviewContent(
  skillsDir: string,
  input: ReviewInput
): Promise<ToolResult> {
  // Load all available personas (for continuation tracking)
  const allPersonas = loadAllPersonas(skillsDir);

  // Load requested personas (or all of them)
  let personas: Persona[];

  if (input.persona_ids && input.persona_ids.length > 0) {
    // Optimized: use batch loading to avoid N file reads for N personas
    personas = loadPersonasByIds(skillsDir, input.persona_ids);

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

  // Track unselected personas for continuation flow
  const activeIds = new Set(personas.map((p) => p.meta.id));
  const remainingPersonas = allPersonas.filter((p) => !activeIds.has(p.meta.id));

  const contextNote = input.context
    ? `\n\n**发布平台 & 目标受众背景**：${input.context}`
    : "";

  // ── Orchestration prompt ──────────────────────────────────────────────────
  const orchestrationPrompt = buildOrchestrationPrompt(
    input.content,
    personas,
    remainingPersonas,
    contextNote
  );

  return {
    content: [
      {
        type: "text",
        text: orchestrationPrompt,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function buildOrchestrationPrompt(
  content: string,
  personas: Persona[],
  remainingPersonas: Persona[],
  contextNote: string
): string {
  const personaBlocks = personas
    .map((p, i) => buildPersonaBlock(p, i + 1, content, contextNote))
    .join("\n\n---\n\n");

  const remainingNames = remainingPersonas.map((p) => p.meta.name).join("、");

  const remainingBlock =
    remainingPersonas.length > 0
      ? `\n## 🔄 延续测试

本轮有 **${remainingPersonas.length} 个人设未参与评测**：${remainingNames}。

**完成汇总报告后：**
1. 向用户展示报告
2. 询问是否要用剩余评论员（${remainingNames}）继续评测
3. 用户同意则启动新一轮评测（复用本次内容）
4. 用户拒绝则结束`
      : "";

  return `# 🛡️ Kevlar 压力测试任务派发

**待测试内容**（共 ${content.length} 字）已锁定。${contextNote}

你需要激活以下 **${personas.length} 个独立批评人设**，为每个人设开启一个**独立的思维线程**，严格禁止人格串味。每个人设必须只用自己的视角阅读内容，不受其他人设影响。

---

${personaBlocks}

---

## 📊 最终汇总报告

在完成所有人设的独立评论后，请生成一份汇总报告，格式如下：

### 🛡️ Kevlar 压力测试报告

**测试内容摘要**：（一句话概括被测试内容的类型和主题）
**激活人设数量**：${personas.length} 个
**测试完成时间**：（当前时间）

#### 综合风险评估

| 维度 | 风险等级 | 说明 |
|------|---------|------|
| 逻辑严密性 | 🟢/🟡/🔴 | （说明） |
| 前段留存率 | 🟢/🟡/🔴 | （说明） |
| 传播潜力 | 🟢/🟡/🔴 | （说明） |
| 整体可信度 | 🟢/🟡/🔴 | （说明） |

#### 高优先级修改建议

1. **最紧急**：（来自哪个人设的哪个核心槽点）
2. **次要**：（另一个重要建议）
3. **锦上添花**：（可选优化点）

#### 一句话总评

（一句最犀利的总结：这份内容现在能不能发？）
${remainingBlock}
---
*由 Kevlar MCP Server 驱动 · 本地多智能体内容防弹衣*`;
}

function buildPersonaBlock(
  persona: Persona,
  index: number,
  content: string,
  contextNote: string
): string {
  return `## 第 ${index} 号子代理：${persona.meta.name}

**角色描述**：${persona.meta.description}

**指令**：请你完全进入以下系统人设，用这个角色的思维方式、语言风格和批判标准，独立阅读下方内容并给出评论。

<系统人设开始>
${persona.systemPrompt}
</系统人设结束>

**待评审内容**：
<content>
${content}
</content>
${contextNote}

请严格按照该人设要求的输出格式作答。`;
}
