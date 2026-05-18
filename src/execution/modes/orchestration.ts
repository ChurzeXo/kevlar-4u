/**
 * Orchestration Execution Mode
 * 
 * Bundles all persona instructions into a single prompt,
 * dispatched to the host AI client for execution.
 * Zero token cost - Kevlar itself doesn't call any model.
 */

import type { ExecutionContext, ExecutionHandler, ExecutionResult, ExecutionMode } from "../base.js";
import type { Persona } from "../../utils/parser.js";

export const MODE: ExecutionMode = "orchestration";

// ── Handler ───────────────────────────────────────────────────────────────────

export const orchestrationHandler: ExecutionHandler = {
  mode: MODE,
  priority: 30, // Lowest priority (fallback)

  canExecute(): boolean {
    // Orchestration mode is always available - no external dependencies
    return true;
  },

  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { personas, content, context: contextNote } = ctx;
    const remainingPersonas: Persona[] = []; // Tracked at tool level

    const prompt = buildOrchestrationPrompt(content, personas, remainingPersonas, contextNote);

    return {
      report: prompt,
      personas: personas.map((p) => p.meta.id),
      mode: MODE,
    };
  },
};

// ── Prompt Builder ───────────────────────────────────────────────────────────

function buildOrchestrationPrompt(
  content: string,
  personas: Persona[],
  remainingPersonas: Persona[],
  contextNote?: string
): string {
  const personaBlocks = personas
    .map((p, i) => buildPersonaBlock(p, i + 1, content, contextNote))
    .join("\n\n---\n\n");

  const contextSection = contextNote
    ? `\n\n**发布平台 & 目标受众背景**：${contextNote}`
    : "";

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

**待测试内容**（共 ${content.length} 字）已锁定。${contextSection}

你需要激活以下 **${personas.length} 个独立批评人设**，为每个人设开启一个**独立的思维线程**，严格禁止人格串味。每个人设必须只用自己的视角阅读内容，不受其他人设影响。

---

${personaBlocks}

---

## 📊 最终汇总报告

在完成所有人设的独立评论后，请生成一份汇总报告，格式如下：

### 🛡️ Kevlar 压力测试报告

**执行模式**：编排代理模式

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
  contextNote?: string
): string {
  const contextSection = contextNote
    ? `\n**发布平台 & 目标受众背景**：${contextNote}`
    : "";

  return `## 第 ${index} 号子代理：${persona.meta.name}

**角色描述**：${persona.meta.description}

**指令**：请你完全进入以下系统人设，用这个角色的思维方式、语言风格和批判标准，独立阅读下方内容并给出评论。

<系统人设开始>
${persona.systemPrompt}
</系统人设结束>

**待评审内容**：
<content>
${content}
</content>${contextSection}

请严格按照该人设要求的输出格式作答。`;
}
