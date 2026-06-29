# 003 — Pro 层 Agent Result Slot 持久化：逐审计员提结果，服务端聚合

## 状态

提议中

## 背景

当前 Subagent 调度架构中，Kevlar 将 AgentBlueprint 发给 Host AI，Host AI 创建子代理执行审计，**在 Host 端完成全部聚合**后，调用 `review_content_wizard_continue` 提交单个聚合后的 ExecutionReceipt。

此设计在 Free 层够用，但在 Pro 层存在三个问题：

### 问题 1：聚合黑盒不可审计

```
subagent-1 (legal_compliance) ──┐
subagent-2 (social_risk)     ──┤
subagent-3 (context_dist)    ──┤── Host AI 聚合 → aggregated receipt
subagent-4 (network_culture) ──┤
subagent-5 (factual)         ──┤
subagent-6 (cross_lingual)   ──┘
                                   ↓
                            validateReceipt() 只验格式
                            runAggregationValidation() 验协议
                            state.preAuditReport ← 聚合后结果
```

`state.preAuditReport` 只存聚合后的维度结果，无法回答以下问题：
- "legal_compliance 审计员当时说了什么？"（溯源丢失）
- "Host 在聚合时把哪些 findings 过滤掉了？"（无法验证）
- "整合后的风险等级是 Host 自己升的级还是 Kevlar 算的？"（责任不清）

### 问题 2：单 agent 失败 = 全量重试

当前 `review_content_wizard_continue` 是单次批量提交。如果 Host AI 在聚合后发现一个 agent 的 findings 不完整，没有"重试这一个 agent"的选项——必须全部重来。

### 问题 3：聚合逻辑在 Host 端，Pro 无法利用服务端协议增强

Pro 层有完整的 `PromptSegments`（coreReasoningFramework、coreFrameworkSteps）、协同规则、交叉验证提示。这些内容当前被内联到每个 agent 的 `instructions` 中，但最终的 **交叉验证（Step 6）** 和 **最终仲裁（Step 8）** 是 Host AI 执行的——Pro 的增强提示颗粒丢失：Host 不一定会用，也无法确保用法正确。

## 决策

### 核心变更

在 Pro 层，将**单次批量提交 receipt** 改为**逐 agent slot 写入 + 服务端自动聚合**：

```
当前 (Free + Pro)                    Pro 新增模式
┌──────────────────┐               ┌──────────────────────┐
│ Host 聚合后提交   │               │ 逐 agent 独立提交     │
│                  │               │                      │
│ continue(         │               │ continue(            │
│   receipt: {      │               │   agentId: "legal",  │
│     agents: [...],│               │   result: {...}      │
│     aggregation:{}│               │ ) → slot 写入        │
│   }               │               │                      │
│ )                 │               │ continue(            │
│ → 校验 → 写入    │               │   agentId: "social", │
│   preAuditReport  │               │   result: {...}      │
│                   │               │ ) → slot 写入        │
│ 双方接受此模式    │               │ ...                  │
│ 不透明但简单      │               │ ↓ 全部 slot 填满      │
│                   │               │ Kevlar 自动聚合:      │
│                   │               │ 1. mergeLocalFindings│
│                   │               │ 2. crossValidate     │
│                   │               │ 3. calculateSynergy  │
│                   │               │ 4. finalizeReport    │
│                   │               │                      │
│                   │               │ 完全可审计、可重试    │
└──────────────────┘               └──────────────────────┘
```

### 新状态字段

`ReviewWizardState` 新增：

```typescript
// Pro only: per-agent result slots
agentSlots?: {
  total: number;                                  // 蓝图定义的 agent 总数
  received: Record<string, AgentSlotResult>;      // agentId → 该 agent 的提报结果
}
```

`AgentSlotResult` 定义：

```typescript
interface AgentSlotResult {
  agentId: string;
  status: "completed" | "failed";
  submittedAt: number;
  output: {
    findings: Finding[];        // 保留原始 findings
    reasoning?: string;         // 审计推理过程
    confidence?: number;        // 置信度 (0-1)
  };
}
```

### review_content_wizard_continue 变更

增加可选字段 `agentId`：

| 字段 | 有 `agentId` | 无 `agentId` |
|------|-------------|-------------|
| 含义 | 单 agent slot 提报 | 聚合后批量提报（Free 兼容） |
| 校验 | `validateSingleAgentResult()` | `validateReceipt()`（现状） |
| 状态变化 | 写入 `agentSlots.received[agentId]` | 聚合后写入 `preAuditReport` |
| 是否填满检查 | 检查 `Object.keys(received).length === total` | 不检查 |
| 聚合触发 | 填满后自动触发 | 立即触发 |
| 出错处理 | 只影响当前 agent slot | 整体 fallback |

### 自动聚合流程（全部 slot 填满后触发）

```
全部 slot 填满
    ↓
1. 收集所有 agent output.findings 作为 rawFindings
2. 执行当前已有的 Steps:
   - Step 5: mergeLocalFindingsIntoAudits()    [代码层，已有]
   - Step 6: crossValidateRiskyDimensions()    [LLM 层，通过 sampling 调用]
   - Step 7: calculateSynergy()                 [代码层，已有]
   - Step 8: finalizePreAuditReport()           [LLM 层，通过 sampling 调用]
3. 构造 preAuditReport + 写入 state
4. 自动推进到 rstConfirmation / checkPersonaInventory
```

### LLM 层 Steps (6, 8) 的降级

如果 Pro 没有 sampling 可用，Step 6 和 Step 8 使用代码层简化版：

| Step | 有 sampling | 无 sampling |
|------|-------------|-------------|
| Step 6 | `crossValidateRiskyDimensions()` — 6 对向/双向 LLM 检查 | 跳过（code-level 无交叉验证） |
| Step 8 | `finalizePreAuditReport()` — LLM 去重 + 链放大 + worstCaseNarrative | code-level 去重 + `risk_maximization` 合并 |

## 对现有设计的影响

### Free 层：零影响

`review_content_wizard_continue` 不带 `agentId` 时完全走旧路径。AgentBlueprint 的 `ContinuationSpec` 在 Free 层不标注 slot 信息。

### Pro 蓝图的引导文本变更

AgentBlueprint 包裹文本中，在 "If you can execute subagent dispatch" 部分增加一段：

```
### Pro: Per-Agent Submission (Recommended)
After each subagent completes, submit its result independently:
1. Call `review_content_wizard_continue` with:
   - agentId: "<agent-id>"
   - result: { output: { findings: [...], reasoning: "..." } }
   - sessionId, checkpoint, expectedRevision from the blueprint
2. Kevlar will acknowledge receipt and track which agents are done
3. When all agents have submitted, Kevlar aggregates automatically

You may also continue submitting aggregated receipts as before
(without agentId) — both modes are supported.
```

### AgentBlueprint 协议扩展

```typescript
interface ContinuationSpec {
  tool: "review_content_wizard_continue";
  sessionId: string;
  checkpoint: string;
  expectedRevision: number;
  idempotencyKey?: string;
  // Pro: slot-based submission metadata
  agentSlots?: {
    total: number;
    agentIds: string[];
    allowPartialSubmit: true;  // 允许逐 agent 提报
  };
}
```

## 收益评估

| 指标 | 当前 | 逐 slot 写入 |
|------|------|-------------|
| **审计溯源** | 无（聚合后丢失） | 每位 agent 原始 findings 保留 |
| **单 agent 重试** | 不可用 | `review_content_wizard_continue(agentId, ...)` 覆盖重写 |
| **聚合确定性** | Host AI 黑盒 | Kevlar 端代码 + LLM 可复现 |
| **部分失败容忍** | 整体失败 | 单 agent 失败不影响其余 |
| **交叉验证质量** | Host prompt 依赖 | server-side prompt 可迭代优化 |

## 阶段计划

### Phase 1（当前 PR）：逐 agent 写入 + 代码层聚合

实现核心基础设施：
- `agentSlots` 状态字段 + `validateSingleAgentResult()` 校验
- `review_content_wizard_continue` 感知 `agentId` 分支
- slot 填满后触发 `mergeLocalFindingsIntoAudits` + `calculateSynergy` 自动聚合（Step 6/8 走简化 code-only 路径）
- Free 层完全不动

### Phase 2（后续 PR）：LLM 交叉验证

- Phase 1 的 slot 聚合完成后，用 sampling 调用 `crossValidateRiskyDimensions` + `finalizePreAuditReport`
- 如果 sampling 失败则降级到 Phase 1 的 code-only 聚合
- 在有 sampling 的 Pro 环境中获得完整审计质量

## 否决的备选方案

### 方案 A：Sessionless Basket（Orchestrator 轮询）

完全消除 session，Orchestrator 创建 basket_id，agent 各自写入 FS，Orchestrator 轮询。

否决原因：
- 需要分布式基础设施（文件锁、轮询、GC）远超当前 6 agent 的需求规模
- session 的 revision 锁在单线程 Node.js 中从未触发过——引入无状态反而增加了分布式复杂度
- 当前架构的子代理已经是纯 LLM 调用，没有写状态冲突

### 方案 B：保留现有单次聚合，只在 Pro 加日志

不改架构，只在 Pro 的 `preAuditReport` 中追加 `rawAgentResults` 字段。

否决原因：
- `rawAgentResults` 如果和聚合后的 dimensions 不一致，谁对？没有诊断标准
- 还是 Host AI 在聚合，Kevlar 无法验证中间结果
- 单 agent 重试仍然不可用

### 方案 C：保持现状，等遇到问题再改

否决原因：
- Pro 层的 contract 就是"更多准确性保证"。当前架构让 Host 做聚合是已知的审计盲点
- slot 写入的方式对现有代码侵入极小（append-only 字段）
- 如果等用户反馈问题了再改，Pro 用户已经经历了不可溯源的审计

## 相关文件

- `src/tools/reviewContentWizardTool.ts` — `ReviewWizardState`、`handleSubagentAuditResult`、`buildAgentBlueprint`
- `src/tools/continueWizardTool.ts` — `review_content_wizard_continue` handler
- `src/execution/protocol.ts` — `validateReceipt`、`runAggregationValidation`、`validateContinuationGate`
- `src/execution/reviewSteps.ts` — `mergeLocalFindingsIntoAudits`、`crossValidateRiskyDimensions`、`finalizePreAuditReport`
- `docs/decisions/002-remove-capability-injection.md` — 三层降级链设计上下文
