# Kevlar-4u 审计需求文档

## 概述

本文档定义 Kevlar-4u 内容风险评测系统的审计需求。系统核心能力是对用户提交的文本执行深度风险检测，通过三层执行链路自适应降级与九步预审流水线，输出结构化风险报告。

## 架构总览

```
用户 → Host AI → Kevlar MCP Tools
                        │
                ┌───────┴───────┐
                │               │
           System Pre-Audit   RST Review
          (9-step pipeline)  (Persona Simulation)
                │               │
                └───────┬───────┘
                        │
                  Review Report
```

## 1. 执行层（Execution Layer）

### 1.1 三层降级链

| 层 | 模式 | 标识符 | 触发条件 | 预审策略 | 并发度 |
|----|------|--------|----------|----------|--------|
| L1 | MCP Sampling | `mcp_sampling` | 客户端声明 `sampling` 能力 | 6 路并行 LLM 调用，每维一路 | 6 |
| L2 | Subagent 分发 | `mcp_subagent` | Host AI 支持 Task/Subagent 工具 | AgentBlueprint → Host 创建 6 个独立子智能体 | 6（Pro 支持逐槽提交 + 服务端聚合） |
| L3 | 宿主编排 | `orchestration` | 以上均不可用 | 单轮推理填充 6 个 XML 沙箱 | 1（序列） |

> **v2.1 变更**: `direct_api` 模式已移除（被 `mcp_sampling` + Host AI 的 `samplingFn` 注入覆盖，不再单独作为一层降级链）。

### 1.2 模式解析优先级

优先级编号越低越优先：`mcp_sampling` (10) → `mcp_subagent` (15) → `orchestration` (30)。

解析顺序：
1. `skills/kevlar-config.json` 中的 `mode` 字段
2. `KEVLAR_MODE` 环境变量
3. 自动检测：capability → API key → fallback

### 1.3 审计要求

- 模式解析结果必须在日志中记录（`event: mode_resolved`，含 `requested`、`resolved`、`reason`）
- L2 模式（子智能体分发）必须输出 `AgentBlueprint`
- 模式降级必须记录原因（如 `sampling_capability_missing`、`structured_fallback`）
- `mcp_subagent` 模式必须通过 `getHostStructuredObservation()` 缓存检查，避免重复检测

## 2. 协议层（Protocol Layer）

### 2.1 AgentBlueprint（L2 分发契约）

**定义文件**: `src/execution/protocol.ts:15-65`

Host AI 收到后有三种合法响应：
1. 执行分发 → 通过 `review_content_wizard_continue` 提交 `ExecutionReceipt`
2. 逐 agent 提交（仅 Pro） → 每 agent 调用一次带有 `agentId` 的 `review_content_wizard_continue`
3. 能力不足 → 回复 `SEQUENTIAL_FALLBACK`，Kevlar 降级到 L3

**必填字段**:
- `protocol: "kevlar.exec/v1"`
- `execution.mode: "ephemeral_agents"`
- `agents`: AgentDefinition 数组，每个含 `id`、`role`、`instructions`、`input`、`outputSchema`
- `aggregation`: AggregationSpec，含 `strategy: "host_merge"`、`outputSchema: "kevlar.audit/v1"`
- `continuation`: ContinuationSpec，含 `tool`、`sessionId`、`checkpoint`、`expectedRevision`
- Pro 附加：`continuation.agentSlots`（`total`、`agentIds`、`allowPartialSubmit: true`）

**审计要求**:
- Blueprint 的 `continuation` 必须包含 `idempotencyKey`，防止重复提交
- `continuation.agentSlots` 只在 Pro 状态机中出现，Free 层不得生成
- `agents` 数组长度必须等于 6（对应 6 个系统审计维度）
- 每个 `agent.id` 必须在 `agentSlots.agentIds` 中存在（如果有）

### 2.2 ExecutionReceipt（执行回执）

**定义文件**: `src/execution/protocol.ts:99-133`

| 字段 | 要求 |
|------|------|
| `protocol` | 必须为 `"kevlar.exec/v1"` |
| `execution.requestedMode` | 必须为 `"ephemeral_agents"` |
| `execution.actualMode` | 必须为 `"native_subagent"` / `"simulated_agent"` / `"orchestration_fallback"` |
| `execution.requestedConcurrency` | 整型，≥1 |
| `execution.actualConcurrency` | 整型，≥1 |
| `execution.contextIsolation.achieved` | `true` / `false` / `"unknown"` |
| `agents` | 非空数组，每项含 `id`、`status`、`output` |
| `agents[].status` | 仅允许 `"completed"` / `"failed"` |
| `agents[].output.findings` | 数组，已完成 agent 必须有 |
| `aggregation` 或 `dimensions` | 聚合报告，含 `dimensions[]` 和 `summary` |

**审计要求**:
- `validateReceipt()` 必须通过（轻量格式校验）
- `runAggregationValidation(receipt, blueprint)` 必须返回 `valid` / `partial` / `fallback_used`
- `status` 为 `invalid` 的 receipt 必须触发 `fallbackToStandardOrchestration()`
- 隔离安全违规（`isolation.required=true` 但 `achieved=false`）必须升级风险等级

### 2.3 AgentSlotResult（Pro 逐槽提交）

**定义文件**: `src/execution/protocol.ts:71-79`

| 字段 | 要求 |
|------|------|
| `agentId` | 必须匹配 `agentSlots.agentIds` 中的某一项 |
| `status` | 仅允许 `"completed"` / `"failed"` |
| `submittedAt` | Unix 时间戳（ms） |
| `output.findings` | 数组，`status="completed"` 时必须为非空数组 |
| `output.reasoning` | 可选，推理过程 |

**审计要求**:
- `validateSingleAgentResult(expectedAgentId, result)` 必须通过
- Free 层收到带 `agentId` 的调用必须返回错误（禁止 Pro 协议泄露到 Free）
- 允许覆盖提交（同 agentId 重复调用覆盖旧值）
- 失败 agent（`status="failed"`）接受但不参与聚合

### 2.4 AggregationValidation（聚合验证）

**定义文件**: `src/execution/protocol.ts:137-158`

| 字段 | 要求 |
|------|------|
| `checks.schemaValid` | receipt 输出格式符合 kevlar.audit/v1 |
| `checks.allAgentsPresent` | receipt agent 数量/ID 与 blueprint 对齐 |
| `checks.aggregationConsistent` | 聚合维度与 agent 输出一一对应 |
| `checks.executionMismatch` | requestedMode ≠ actualMode |
| `checks.isolationViolation` | 要求隔离但未实现 |

**状态机转换**:
- `valid` → 正常推进
- `partial` → 接受但标记
- `invalid` → fallbackToStandardOrchestration
- `fallback_used` → 接受但记录 executionMismatch

## 3. 预审流水线（Pre-Audit Pipeline）

### 3.1 九步流水线

| 步骤 | ID | 执行者 | 输入 | 输出 | LLM 调用 |
|------|----|--------|------|------|----------|
| 0a | `rule_engine` | 代码 | 原文 | `localFindings[]` | 否 |
| 0b+搜索 | `step0` | Host AI | `localFindings` | `step0Result` + `webContextMap` | 宿主持有 |
| 1 | `strip_context` | 代码 | 原文 | `stripped` (original/bare/replacements) | 否 |
| 2 | `bare_audit` | LLM | bare 文本 + 3 个维度 | `bareFindings[]` | 是（3 路并行） |
| 3 | `full_audit` | LLM | 全文 + 6 个维度 | `fullFindings[]` | 是（6 路并行） |
| 4 | `delta_analysis` | 代码 | bare + full findings | `deltaRisks` (bareOnly/fullOnly/stable) | 否 |
| 5 | `merge_local_findings` | 代码 | full findings + localFindings | `mergedResults[]` | 否 |
| 6 | `cross_validation` | LLM | mergedResults | `crossValidatedResults[]` | 是（6 对交叉验证） |
| 7 | `synergy_weighting` | 代码 | crossValidatedResults | `synergy` | 否 |
| 8 | `final_arbitration` | LLM | 全量上下文 | `PreAuditReport` | 是（1 路终审） |
| 9 | `display` | 代码 | PreAuditReport | 用户界面 | 否 |

### 3.2 步骤详解

#### Step 0a — 本地规则引擎

**函数**: `buildRuleFindings()` → `src/tools/reviewContentWizardTool.ts`

- n-gram 滑动窗口匹配（2-4 gram）
- L2 结构模式检测（语法/语义模板）
- Multi-hop 模式匹配（组合规则）
- 输出命中规则的 `localFindings[]`

#### Step 0b+搜索 — 风险模拟逆向解码

**函数**: `buildOrchestrationStep0Prompt()` → `src/prompts/reviewWizard.ts`

Host AI 合并执行：
1. 语言边界判定 + 网络谐音/歧义翻译提取
2. 风险原子提取（存在传播风险的词汇）
3. 情绪重构 + 攻击链推演
4. 联网搜索 + 类似事件先例检索

输出：
- `step0Result.wildTranslations`
- `step0Result.blackAtoms`
- `step0Result.attackCandidates`
- `step0Result.precedents`
- `webContextMap`（关键词 → 搜索结果）

#### Step 1 — 物理脱嵌

**函数**: `stripContext()` → `src/utils/stripContext.ts`

分割为三部分：
- `original`: 原文
- `bare`: 裸文（去品牌/链接/格式）
- `replacements`: 替换映射表

#### Step 2 — 裸文审计

**函数**: `runSystemAuditors(bare, [context_distortion, network_culture_risk, cross_lingual_distortion])`

三个只依赖文本本身的维度（不含品牌/格式信息），并行执行 LLM 推理。

#### Step 3 — 全文审计

**函数**: `runSystemAuditors(full, [所有 6 个 system_auditors])`

六个维度并行执行：
- `legal_compliance`（合规哨兵）
- `social_risk`（社伦判官）
- `context_distortion`（语境猎手）
- `network_culture_risk`（暗语破译）
- `factual_integrity`（事实判官）
- `cross_lingual_distortion`（跨界判官）

#### Step 4 — Delta 分析

**函数**: `computeDeltaAnalysis(bareFindings, fullFindings)`

对比裸文 vs 全文发现：
- `bareOnly`: 脱嵌放大型（只有裸文才有）
- `fullOnly`: 全文特有
- `stable`: 两端都有的稳定风险

#### Step 5 — 合并本地发现

**函数**: `mergeLocalFindingsIntoAudits(auditorResults, localFindings)`

- `localFindings` 注入到 `network_culture_risk` 维度
- 如无此维度则新建 `local_rule_engine`

#### Step 6 — 交叉验证

**函数**: `crossValidateRiskyDimensions(content, mergedResults, auditors, samplingFn)`

六对双向/单向交叉验证：

| 源维度 | 验证方 | 目的 |
|--------|--------|------|
| `network_culture_risk` | `context_distortion` | 暗语在真实语境中是否易被曲解 |
| `context_distortion` | `network_culture_risk` | 语境风险是否存在网络黑话含义 |
| `social_risk` | `factual_integrity` | 社会风险是否有事实硬伤 |
| `legal_compliance` | `social_risk` | 合规问题是否会触发舆论对立 |
| `cross_lingual_distortion` | `network_culture_risk` | 外文词是否有中文网络恶搞梗 |
| `network_culture_risk` | `cross_lingual_distortion` | 网络文化词是否涉及跨语言曲解 |

结果状态：`confirmed`（增强确认）、`downgraded`（降级）、`debunked`（消除）

**相位设计**：
- Phase 1（并行）：所有 6 对 LLM 调用同时发射
- Phase 2（串行）：依序应用结果（debunked 移除、downgraded 降级、confirmed 跨维传播）

#### Step 7 — 协同加权

**函数**: `calculateSynergy(dimensionLevels, extraFlags?, customRules?)` → `src/execution/synergyCalculator.ts`

内置规则：
| # | 条件 | 组合 | 乘数 | 升级 |
|---|------|------|------|------|
| 1 | ALL | `social_risk` + `network_culture_risk` | 2.5× | 🟡→🔴 |
| 2 | ALL | `context_distortion` + `network_culture_risk` | 2.0× | 🟡→🔴 |
| 3 | ALL | `legal_compliance` + `social_risk` + `context_distortion` | 3.0× | 🟡→🔴 |
| 4 | ANY | `timing_risk` | 1.5× | 否 |

Pro 增强：从策略包注入 `synergyRules` 覆盖默认规则。

#### Step 8 — 最终仲裁

**函数**: `finalizePreAuditReport()` → `src/execution/reviewSteps.ts`

LLM 终审官执行：
- 合并重复 findings
- 强化攻击链描述
- 生成 worstCaseNarrative
- 应用 levelUpgrades（来自 Step 7）
- 输出 `PreAuditReport`（含 `dimensions`、`summary`、`riskProfile`、`synergyFlags`）

**失败处理**：LLM 失败时回退为确定性摘要（`summarizeFallback()`），仍应用 synergy levelUpgrades。

#### Step 9 — 结果展示

- 风险等级摘要（表格）
- 维度详情（keyword、level、trigger、riskDescription）
- 协同标记（cross-dimension escalation）
- Delta 标记（bareOnly/fullOnly/stable）
- 类似事件先例
- 是否继续复审的选择

### 3.3 审计要求

- 每一步都必须在 `ctx`（ReviewStepContext）上记录输出
- LLM 步骤（2、3、6、8）必须包装 try/catch，失败时不阻断整条流水线
- Step 6（交叉验证）LLM 调用失败时跳过该对验证，不影响其他对
- Step 8（最终仲裁）LLM 失败时使用 `summarizeFallback()` 降级输出
- Step 6 和 Step 8 在 auto-aggregation 模式（Pro slot-based）下必须检查 `isAutoAggregated && samplingFn`，无可用的 `samplingFn` 时跳过 LLM 步骤并记录警告

## 4. Slot-Based 逐槽提交系统（Pro 003）

### 4.1 状态模型

```typescript
ReviewWizardState.agentSlots = {
  total: number;        // 总槽位数（= agents.length）
  received: Record<string, AgentSlotResult>;  // agentId → result
}
```

### 4.2 生命周期

1. **创建**: `buildAgentBlueprint()` 将 `continuation.agentSlots` 注入 blueprint
2. **提交**: Host AI 调 `review_content_wizard_continue(sessionId, checkpoint, expectedRevision, continuationId, agentId, result)`
3. **验证**: `handleAgentSlot()`:
   - 检查 step 是否 `waitingForSubagentAudit`
   - 检查 tier 是否为 Pro（非 Pro 返回错误）
   - 检查 continuation revision/continuationId 是否匹配
   - 检查 `agentId` 是否在 `agentSlots.agentIds` 中
   - 调用 `validateSingleAgentResult()` 做格式校验
4. **写入**: 写入 `state.agentSlots.received[agentId]`，递增 revision
5. **检查填满**: 若 `Object.keys(received).length === total`，触发 `finalizeSlots()`
6. **过期**: 若 `continuation.expiresAt < Date.now()` 且未填满，触发 Partial Auto-Finalize

### 4.3 触发自动聚合的条件

```
finalizeSlots()
  ↓
buildSyntheticReceipt(slots)
  ↓
    extract completed slots (skip failed)
    ↓
    if (completed === 0) → internalError("zero completed agents, cannot aggregate")
    ↓
    map each agent's findings to a dimension, inject _isPartial, _failedAgents markers
  ↓
handleReviewContentWizard(receipt)  →  正常 pipeline:
    mergeLocalFindingsIntoAudits  (Step 5, 代码)
  ↓ Phase 2:
    crossValidateRiskyDimensions (Step 6, LLM)  [仅当 isAutoAggregated && samplingFn]
  ↓
    calculateSynergy             (Step 7, 代码)
  ↓ Phase 5:
    finalizePreAuditReport       (Step 8, LLM)  [仅当 isAutoAggregated && samplingFn]
  ↓
    result
```

### 4.4 槽位过期处理

- TTL: 30 分钟（从 `activeContinuation.expiresAt` 计算）
- 过期检查时机：每次 `handleAgentSlot()` 调用时
- 过期行为：`finalizeSlots()` 使用可用 results（跳过未提交的 agent）
- 已经填满的会话不受影响（slot-full 状态在填满时立即触发聚合）

### 4.5 审计要求

- `agentSlots` 只在 Pro 状态中有效，Free 状态机必须屏蔽
- 每次 slot 写入后必须递增 `state.revision`
- `buildSyntheticReceipt()` 必须排除 `status !== "completed"` 的 agent
- 零个 completed agent 时必须抛出 `internalError`
- `_isPartial` 和 `_failedAgents` 元数据必须附加到合成 receipt 中
- 过期检查必须在 `handleAgentSlot()` 中执行，而不是在 `finalizeSlots()` 中
- `handleAgentSlot()` 必须返回剩余未提交 agentId 列表，便于 Host AI 继续提交

## 5. 验证门（Validation Gates）

### 5.1 validateReceipt（轻量格式校验）

**定义**: `src/execution/protocol.ts:446-506`

- 检查 receipt 是有效对象、protocol 是 `kevlar.exec/v1`
- agents 是数组且非空
- 每个 agent 有 `id`、`status`、`output`
- aggregation 存在（warning 级别）
- 返回 `errors[]` 和 `warnings[]`，不抛异常

### 5.2 runAggregationValidation（完整语义校验）

**定义**: `src/execution/protocol.ts:180-352`

四个门：
- Gate 1: Schema 一致性（每个 agent 的 output.findings 有效）
- Gate 2: Agent 数量对齐（与 blueprint 匹配）
- Gate 3: 聚合一致性（维度与 agent 一一对应）
- Gate 4: 执行模式 + 隔离安全检测

返回：`valid` / `partial` / `invalid` / `fallback_used`

### 5.3 validateSingleAgentResult（单槽格式校验）

**定义**: `src/execution/protocol.ts:512-550`

- 检查 `agentId` 存在且匹配预期
- 检查 `status` ∈ { `completed`, `failed` }
- 检查 `output` 存在且 `output.findings` 为数组

### 5.4 Continuation Guard（乐观锁）

**定义**: `src/execution/protocol.ts:359-385`

- `revision` 必须匹配（防旧回合覆盖新状态）
- `continuationId` 必须匹配（防并发冲突）
- 不合格 → `validationError("stale_continuation_revision_locked" | "continuation_id_mismatch")`
- `status="invalid"` → `fallbackToStandardOrchestration(state, "schema_mismatch")`

### 5.5 审计要求

- 所有验证门必须在关键路径上执行
- `runAggregationValidation` 应当记录风险等级和原因
- 隔离安全违规（`isolationViolation`）必须升级风险等级
- `fallbackToStandardOrchestration` 必须更新 checkpoint、revision、executionTransitions

## 6. 状态机与向导（State Machine & Wizards）

### 6.1 核心状态

| 状态 | 含义 |
|------|------|
| `idle` | 空闲 |
| `collectingInfo` | 采集用户意图/内容 |
| `step0_completed` | Host AI 完成 Step 0 解码 |
| `waitingForSubagentAudit` | 等待 Host AI 提交审计结果（L2 路径） |
| `waitingForOrchestrationStep0` | 等待宿主编排的 Step 0 结果（L3 路径） |
| `waitingForOrchestrationAudit` | 等待宿主编排的审计结果（L3 路径） |
| `rstConfirmation` | 预审完成，等待用户确认是否进入复审 |
| `checkPersonaInventory` | 检查并推荐复审人员 |
| `readyForRstReview` | 就绪等待 RST 复审启动 |
| `rstReviewInProgress` | RST 复审进行中 |
| `completed` | 流程完成 |

### 6.2 Checkpoint + Revision 协议

- 每次状态转换递增 `state.revision`
- `activeContinuation` 包含 `continuationId`、`checkpoint`、`expiresAt`、`retryCount`
- `review_content_wizard_continue` 必须提交 `expectedRevision` 和 `continuationId`
- Revision 不匹配时抛出 `stale_continuation_revision_locked`

### 6.3 审计要求

- `MAX_CONTINUATION_RETRIES = 3`，超限后必须强制降级到 L3
- 状态变更必须在日志中记录（`event: state_transition`，含 `from`、`to`、`reason`）
- 所有 wizard 中间状态必须持久化到 `skills/tmp/`，老化 >24h 的 draft 在启动时清理

## 7. 安全边界

### 7.1 输入验证

| 字段 | 规则 |
|------|------|
| `sessionId` | 仅允许 `[a-z0-9-]+`，最大 128 字符 |
| `continuationId` | 仅允许 `[a-z0-9-]+` |
| `agentId` | 仅允许 `[a-zA-Z0-9_-]+` |
| 文件写入 | 仅限 `skills/` 目录 |

### 7.2 资源限制

| 参数 | 默认值 | 范围 |
|------|--------|------|
| `KEVLAR_MAX_CONCURRENT` | 3 | 1-10 |
| `KEVLAR_MIN_DELAY_MS` | 1000 | ≥0 |
| `KEVLAR_TOKEN_BUDGET_PER_TASK` | 50000 | ≥1000 |
| `KEVLAR_RETRY_MAX` | 3 | 0-10 |
| `KEVLAR_TASK_TTL_MS` | 300000 | ≥60000 |
| `KEVLAR_TASK_TOTAL_TIMEOUT_MS` | 600000 | ≥120000 |
| `KEVLAR_TASK_POLL_MS` | 1000 | ≥200 |

### 7.3 审计要求

- Review lock（非 orchestration 模式）必须防止并发运行
- Lock 5 分钟 TTL 过期后必须自动释放
- API key 不得通过工具参数传递或写入配置文件

## 8. 测试要求

### 8.1 单元测试覆盖

| 模块 | 最低覆盖 |
|------|----------|
| `protocol.ts` | 所有 validate* 函数、runAggregationValidation |
| `reviewSteps.ts` | 所有 step 函数、computeDeltaAnalysis、mergeLocalFindingsIntoAudits、crossValidateRiskyDimensions、finalizePreAuditReport |
| `reviewContentWizardTool.ts` | buildSyntheticReceipt、handleSubagentAuditResult、buildAgentBlueprint |
| `continueWizardTool.ts` | handleAgentSlot、finalizeSlots |
| `synergyCalculator.ts` | calculateSynergy（所有内置规则） |

### 8.2 场景测试

| 场景 | 期望 |
|------|------|
| 所有 agent 成功提交 | 触发正常聚合，生成完整报告 |
| 部分 agent 失败 | `_isPartial: true`，聚合正常 |
| 所有 agent 失败 | 抛出 internalError |
| 槽位过期 | 触发 partial auto-finalize |
| 覆盖提交（同一 agentId 第二次） | 覆盖旧值 |
| Free 层带 agentId | 返回错误（Pro 功能） |
| Revision 不匹配 | 抛出 stale_continuation_revision_locked |
| Cross-validation LLM 失败 | 跳过该对，不影响其他对 |
| Final arbitration LLM 失败 | 回退为确定性摘要，仍应用 synergy levelUpgrades |
| SEQUENTIAL_FALLBACK | 降级到 L3 orchestration |

### 8.3 集成测试

- 必须有 E2E 测试覆盖完整的 review_content_wizard → continue 流程
- `InMemoryTransport` 用于模拟 MCP 通信
- 测试必须创建临时目录（`fs.mkdtempSync`）并在 afterEach 中清理

## 9. 术语表

| 术语 | 定义 |
|------|------|
| Agent Slot | Pro 层中分配给单个审计员的独立结果槽位 |
| AgentBlueprint | Kevlar 发给 Host AI 的子智能体分发契约 |
| ExecutionReceipt | Host AI 执行完子智能体后返回的执行回执 |
| AggregationValidation | 对 ExecutionReceipt 的语义验证结果 |
| Continuation Guard | 乐观锁机制，防止旧回合覆盖新状态 |
| Checkpoint | 状态机中的检查点标识 |
| Revision | 状态版本号，每次变更递增 |
| PreAuditReport | 九步流水线的最终输出报告 |
| Synergy | 跨维度风险协同加权机制 |
| Cross-Validation | 维度之间的 LLM 交叉验证 |
| Delta Analysis | 裸文 vs 全文的风险差异分析 |
| Focus Topic | 预审结果经 RST 触发器过滤后下发给复审人员的焦点主题 |
| isAutoAggregated | Pro slot-based 模式的标识，由 `agentSlots.received` 是否有内容决定 |
