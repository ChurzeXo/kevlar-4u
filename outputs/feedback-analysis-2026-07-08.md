# 测试 AI 反馈分析报告

> 日期: 2026-07-08
> 来源: Pro 版评测过程中测试 AI 的反馈
> 状态: 4 项建议修复，1 项不采纳

---

## ❌ 问题 1+6：DeferExecuteTool 参数结构报错 + Schema 描述不足

**现象**：
```
Error: "toolName" is required. Provide the exact tool name as returned by ToolSearch.
```

**根因**：不是 Kevlar 代码 bug，是 Host AI 与 DeferExecuteTool 的参数结构匹配问题。

- `review_content_wizard_continue` 的 MCP schema 中是扁平参数：`{sessionId, checkpoint, expectedRevision, continuationId, receipt}`
- 通过 DeferExecuteTool 调用时，需要外层套 `params`：
  ```json
  {
    "toolName": "mcp__kevlar-4u__review_content_wizard_continue",
    "params": {
      "sessionId": "...",
      "checkpoint": "preaudit_completed",
      "expectedRevision": 1,
      "continuationId": "...",
      "receipt": { ... }
    }
  }
  ```
- Host AI 第一次按 flat schema 传参（`receipt` 当作顶层 key），DeferExecuteTool 找不到 `toolName` 就报错了。

**修复**：在工具 schema `description` 中加入 DeferExecuteTool 调用示例。

**改动量**：1 行 description 补充。

**优先级**：🟡 P1

---

## ⚠️ 问题 2：代码层确定性引擎与 LLM 语义分析断层

**现象**：代码层 Step 5（合并）+ Step 7（协同加权）产出全 🟢 空 findings，而 6 个 LLM 子智能体实际发现 🔴 级风险。

**根因**：

- 代码层规则引擎 `buildRuleFindings()` 依赖 `skills/rules.json` 关键词匹配
- 规则库以中文关键词为主（滑动窗口匹配），当内容为纯英文时命中率为零
- `mergeLocalFindingsIntoAudits()` 不会删除 LLM 发现（只增不删），所以 LLM 结果不受影响
- 但 `synergyCalculator` 因为代码层空输入，失去跨维度联动能力
- 工作流中没有显式标注"规则引擎覆盖范围限定于中文关键词"

**修复**：在 `orchestrationPreAuditContext` 中 `localFindings` 为空时，在传给 LLM 的上下文中附加一行覆盖声明：

> "⚠️ 规则引擎覆盖范围：当前规则库主要覆盖中文关键词。未命中规则 ≠ 无风险。以下 LLM 审计结果不受规则引擎限制，请以 LLM 分析为准。"

实现位置：`src/tools/reviewContentWizardTool.ts` `buildIsolatedContextInstructions()` L1374 附近，注入到规则引擎预警块中。

**改动量**：~5 行。

**优先级**：🟡 P1

---

## ⚠️ 问题 3：状态机回跳逻辑缺少原因说明

**现象**：提交收据后，状态机从 `waitingForSubagentAudit` 回跳到 `waitingForOrchestrationStep0`，多跑了一轮交互。

**根因**：`handleContextAuditResult()` 中有四条回跳路径：

| 行号 | 触发条件 | 回跳目标 |
|------|---------|---------|
| L1697 | Host AI 返回 SEQUENTIAL_FALLBACK | waitingForOrchestrationStep0 |
| L1709 | 检测到口头拒绝模式 | waitingForOrchestrationStep0 |
| L1744 | 收据格式校验失败 | rollbackState + 错误提示 |
| L1770 | 内容漂移检测 | waitingForOrchestrationStep0 |

测试 AI 最可能触发的是：首次 DeferExecuteTool 报错 → Host AI 修正参数重试 → 重试过程中内容 fingerprint 变了 → 内容漂移 → 回跳到 Step 0。

已有回跳提示，但内容漂移的回跳消息可以更明确说明原因。

**修复**：L1770 内容漂移回跳消息改为：

> "⚠️ 内容被修改 — 检测到工作区漂移。在 Subagent 并行执行期间待评测内容发生了变更，之前生成的审计结果已失效。已将执行模式降级为标准宿主编排并重新从 Step 0 开始。"

**改动量**：~3 行。

**优先级**：🟢 P2

---

## ❌ 问题 4：子智能体并行调度一体化

**现象**：6 个子智能体需要 Host AI 手动创建和管理。

**分析**：

- Kevlar 是无状态的 MCP stdio 服务器，不具备直接创建 subagent 的能力
- 子智能体创建是 Host AI（如 Claude Code、WorkBuddy）的功能
- Kevlar 通过 `ExecutionBlueprint` 提供结构化调度清单，这是正确的架构分工
- 改成"一键调度"需要 Kevlar 突破 MCP 协议边界，主动操作 Host AI 的 Task/Agent 工具

**结论**：❌ **不采纳**。架构深层改动，违背 "Host 编排" 设计哲学。如果 Host AI 未来提供 batch subagent 创建 API，可以考虑对接。

---

## ✅ 问题 5：免费版先例锁定体验 — 前置告知

**现象**：Turn 3 协议要求"禁止泄露 precedents 中具体品牌名"，同时底部显示"🔒 类似先例已锁定"。但用户要到报告阶段才看到锁，之前流程中未被告知。

**修复**：在 `skills/templates/free.json` 的 `globalStep0Message` 末尾增加前置告知：

> "💡 免费版提示：类似事件先例的搜索和分析将以抽象方式呈现，具体品牌名将在报告中被锁定。升级 Pro 可查看完整溯源。"

**改动量**：~3 行。

**优先级**：🟢 P2

---

## 汇总

| # | 分类 | 是否修复 | 改动量 | 优先级 |
|---|---|---|---|---|
| 1+6 | DeferExecuteTool 参数说明 | ✅ 修复 | 1 行 description | 🟡 P1 |
| 2 | 代码层覆盖范围声明 | ✅ 修复 | ~5 行 | 🟡 P1 |
| 3 | 状态机回跳原因说明 | ✅ 修复 | ~3 行 | 🟢 P2 |
| 4 | 子智能体一体化 | ❌ 不采纳 | — | — |
| 5 | 先例锁定前置告知 | ✅ 修复 | ~3 行 | 🟢 P2 |

**共 4 项建议修复（约 12 行代码改动），1 项不采纳。**
