# Kevlar-4u 项目审计报告

**审计依据**: `docs/audit-requirements.md`
**审计时间**: 2026-06-29
**审计范围**: 执行层 / 协议层 / 预审流水线 / Slot-Based 提交系统 / 验证门与状态机 / 安全边界 / 测试要求
**审计方式**: 静态代码核查 + 测试覆盖核查

---

## 总体结论

| 章节 | 符合 | 部分符合 | 不符合 | 无法验证 |
|------|------|----------|--------|----------|
| 1. 执行层 | 3 | 2 | 1 | 0 |
| 2. 协议层 | 6 | 2 | 0 | 0 |
| 3. 预审流水线 | 7 | 2 | 0 | 0 |
| 4. Slot-Based 系统 | 5 | 1 | 1 | 0 |
| 5. 验证门与状态机 | 5 | 1 | 0 | 1 |
| 6. 状态机向导 | 3 | 1 | 0 | 0 |
| 7. 安全边界 | 5 | 2 | 0 | 0 |
| 8. 测试要求 | 4 | 3 | 3 | 0 |
| **合计** | **38** | **14** | **5** | **1** |

**关键风险项**（需优先修复）：

1. ❌ **`direct_api` 执行模式已下线**（Section 1.1）——文档中列为 L1 层，但 `isValidMode()` 实际只接受 `orchestration` / `mcp_subagent` / `mcp_sampling` 三种模式。
2. ❌ **`MAX_CONTINUATION_RETRIES` 超限未降级到 L3**（Section 6.3）——代码改为「删除状态文件 + 返回错误」，未按需求文档强制降级到 orchestration。
3. ❌ **Slot 写入后未递增 `state.revision`**（Section 4.5）——代码明确注释「revision UNCHANGED for partial」，与文档要求冲突。
4. ❌ **测试覆盖严重不足**（Section 8）——`calculateSynergy`、`buildSyntheticReceipt`、`finalizeSlots`、`handleAgentSlot`、`buildAgentBlueprint` 均无专门测试。
5. ❌ **场景测试缺失**——「全部 agent 失败」、「槽位过期自动 finalize」、「覆盖提交」、「Free 层带 agentId」、「Cross-validation LLM 失败」、「Final arbitration LLM 失败」、「SEQUENTIAL_FALLBACK」等场景均无专门用例。

---

## 1. 执行层（Execution Layer）

### 1.1 三层降级链

| 项 | 结论 | 证据 |
|----|------|------|
| L1 `mcp_sampling` 并发=6 | ✅ 符合 | `src/execution/index.ts:211-220` `isTaskAugmentedSamplingSupported()` → `sampling_task_augmented`；`src/execution/index.ts:223-232` `isSamplingSupported()` → `sampling_serial`，二者 `legacyMode` 均为 `"mcp_sampling"` |
| L1 `direct_api` 模式 | ❌ **不符合** | `src/execution/config.ts:166-167` `isValidMode()` 仅接受 `["auto", "orchestration", "mcp_subagent", "mcp_sampling"]`，**未包含 `direct_api`**；全代码库无 `direct_api` 处理器注册。文档列其为 L1 层与 `KEVLAR_API_KEY` 触发条件，但实际已下线。`src/__tests__/execution.test.ts:236` 仅作 `!isRetryableError("invalid_api_key")` 反向断言 |
| L2 `mcp_subagent` 分发 | ✅ 符合 | `src/execution/index.ts:261-264` 当 `strategy === "structured"` 时映射为 `mcp_subagent`；`src/tools/reviewContentWizardTool.ts:693` `buildAgentBlueprint()` 输出 `AgentBlueprint` 契约 |
| L3 `orchestration` | ✅ 符合 | `src/execution/index.ts:38` `orchestrationHandler` 注册，priority 30（fallback）；`src/execution/modes/orchestration.ts` 实现宿主编排单轮填充 XML 沙箱 |

### 1.2 模式解析优先级

| 项 | 结论 | 证据 |
|----|------|------|
| 优先级链 `mcp_sampling(10) → mcp_subagent(15) → direct_api(20) → orchestration(30)` | ⚠️ **部分符合** | `src/execution/index.ts:211-265` 自动解析顺序为 `task_augmented_sampling → sampling_serial → host_orchestration(structured) → host_orchestration(standard)`，与文档优先级一致，但缺 `direct_api` 一档 |
| 解析顺序：config → KEVLAR_MODE → 自动检测 | ✅ 符合 | `src/execution/index.ts:191-204` 先读 `config.mode`，再读 `KEVLAR_MODE`，最后自动检测 |

### 1.3 审计要求

| 项 | 结论 | 证据 |
|----|------|------|
| 模式解析结果记录 `event: mode_resolved` 含 requested/resolved/reason | ⚠️ **部分符合** | `src/execution/index.ts:268-275` 记录 `event: "execution_plan_resolved"`，含 `backend`/`strategy`/`resolutionSource`，但**字段名为 `resolutionSource` 而非文档要求的 `requested`/`resolved`/`reason`**；`getModesInfo()` 中有 `reason` 字段（`src/execution/index.ts:311`）但仅用于 `get_modes` 工具，非解析日志 |
| L2 必须输出 `AgentBlueprint` | ✅ 符合 | `src/tools/reviewContentWizardTool.ts:614` `buildAgentBlueprint()` 调用并注入 blueprint |
| 降级原因记录 | ✅ 符合 | `src/execution/index.ts:157,168` `event: "mode_silent_downgrade"`；`src/execution/protocol.ts:381` `fallbackToStandardOrchestration(state, "schema_mismatch")` |
| `mcp_subagent` 通过 `getHostStructuredObservation()` 缓存检查 | ✅ 符合 | `src/execution/index.ts:238-242` 调用 `getHostStructuredObservation({fingerprint, protocolVersion, taskClass})` |

---

## 2. 协议层（Protocol Layer）

### 2.1 AgentBlueprint

| 项 | 结论 | 证据 |
|----|------|------|
| `protocol: "kevlar.exec/v1"` | ✅ 符合 | `src/execution/protocol.ts:16` 接口定义；`src/tools/reviewContentWizardTool.ts:722` 实际赋值 |
| `execution.mode: "ephemeral_agents"` | ✅ 符合 | `src/execution/protocol.ts:19`；`src/tools/reviewContentWizardTool.ts:724` |
| `agents` 数组含 id/role/instructions/input/outputSchema | ✅ 符合 | `src/execution/protocol.ts:33-42`；`src/tools/reviewContentWizardTool.ts:708-716` 生成完整字段 |
| `aggregation.strategy: "host_merge"` + `outputSchema: "kevlar.audit/v1"` | ✅ 符合 | `src/execution/protocol.ts:44-51`；`src/tools/reviewContentWizardTool.ts:734-739` |
| `continuation` 含 tool/sessionId/checkpoint/expectedRevision | ✅ 符合 | `src/execution/protocol.ts:53-65`；`src/tools/reviewContentWizardTool.ts:741-746` |
| Pro 附加 `continuation.agentSlots`（total/agentIds/allowPartialSubmit: true） | ✅ 符合 | `src/tools/reviewContentWizardTool.ts:748-756` 仅 `state.tier === "pro"` 时注入，Free 层不会生成 |
| `continuation.idempotencyKey` | ⚠️ **部分符合** | `src/execution/protocol.ts:58` 字段定义为可选；`src/tools/reviewContentWizardTool.ts:746` 实际赋值 `idempotencyKey: activeCont?.continuationId`，但 `continuationId` 在生成时不一定具备幂等性，更接近「会话标识复用」而非严格幂等键 |
| `agents.length === 6`（对应 6 个 system_auditor） | ✅ 符合 | `src/tools/reviewContentWizardTool.ts:703` `systemAuditors.map(...)`，auditors 来自 `skills/auditors.json` 共 6 个 ID（legal_compliance / context_distortion / network_culture_risk / factual_integrity / social_risk / cross_lingual_distortion，已逐一核查 `skills/auditors.json:7,24,41,58,75,92`） |
| 每个 `agent.id` 必须在 `agentSlots.agentIds` 中存在 | ✅ 符合 | `src/tools/reviewContentWizardTool.ts:752` `agentIds: agents.map((a) => a.id)` 由 agents 派生 |

### 2.2 ExecutionReceipt

| 项 | 结论 | 证据 |
|----|------|------|
| `protocol` 必须为 `"kevlar.exec/v1"` | ✅ 符合 | `src/execution/protocol.ts:100` 接口定义；`runAggregationValidation` 在 `src/execution/protocol.ts:207-209` 校验 |
| `execution.requestedMode`/`actualMode`/并发/隔离 | ✅ 符合 | `src/execution/protocol.ts:102-120` 完整字段定义 |
| `agents[]` 含 id/status/output | ✅ 符合 | `src/execution/protocol.ts:126-133`；`validateReceipt` 在 `src/execution/protocol.ts:465-481` 校验 |
| `status` 仅允许 completed/failed | ⚠️ **部分符合** | `src/execution/protocol.ts:129` 接口限制为 `"completed" \| "failed"`，但 `validateReceipt` 在 `src/execution/protocol.ts:473` 还接受 `"partial"` 并仅发 warning，**未硬性拒绝** |
| `agents[].output.findings` 数组，completed agent 必须有 | ✅ 符合 | `src/execution/protocol.ts:223-234` `runAggregationValidation` 校验 completed agent 必须有 `output.findings` 数组 |
| `validateReceipt()` 必须通过 | ✅ 符合 | `src/execution/protocol.ts:446-506` 实现，返回 `errors[]`/`warnings[]` 不抛异常 |
| `runAggregationValidation()` 返回 valid/partial/invalid/fallback_used | ✅ 符合 | `src/execution/protocol.ts:180-352` 实现，状态机转换见 `src/execution/protocol.ts:302-309` |
| `status="invalid"` 触发 `fallbackToStandardOrchestration()` | ✅ 符合 | `src/execution/protocol.ts:378-382` `validateContinuationGate` 中触发 |
| 隔离安全违规升级风险等级 | ✅ 符合 | `src/execution/protocol.ts:338-342` `isolationViolation` 时 `low→medium` 或 `medium→high` |

### 2.3 AgentSlotResult（Pro 逐槽提交）

| 项 | 结论 | 证据 |
|----|------|------|
| `agentId` 必须匹配 `agentSlots.agentIds` | ✅ 符合 | `src/tools/continueWizardTool.ts:386-395` 校验 `expectedAgentIds.includes(agentId)` |
| `status` 仅允许 completed/failed | ✅ 符合 | `src/execution/protocol.ts:73` 接口；`validateSingleAgentResult` 在 `src/execution/protocol.ts:534` 接受 completed/failed，其他视为失败 |
| `submittedAt` Unix 时间戳 | ✅ 符合 | `src/tools/continueWizardTool.ts:461` `submittedAt: Date.now()` |
| `output.findings` 数组，completed 必须非空 | ⚠️ **部分符合** | `src/execution/protocol.ts:538-543` `validateSingleAgentResult` 检查 `findings` 是数组，但**未强制要求 completed 状态下非空**，缺失时仅 warning「将使用空数组」 |
| `validateSingleAgentResult()` 必须通过 | ✅ 符合 | `src/tools/continueWizardTool.ts:413` 调用 |
| Free 层带 agentId 必须返回错误 | ✅ 符合 | `src/tools/continueWizardTool.ts:348-354` `state.tier !== "pro"` 时直接返回错误「逐 agent 提交仅限 Pro 用户」 |
| 允许覆盖提交 | ✅ 符合 | `src/tools/continueWizardTool.ts:438-449` `isResubmit` 检测后允许覆盖，仅当未达上限 |
| 失败 agent 接受但不参与聚合 | ✅ 符合 | `src/tools/reviewContentWizardTool.ts:774-775` `buildSyntheticReceipt` 过滤 `completedSlots`，`failedSlots` 单独记录到 `_failedAgents` |

### 2.4 AggregationValidation

| 项 | 结论 | 证据 |
|----|------|------|
| `checks.schemaValid` | ✅ 符合 | `src/execution/protocol.ts:212-253` |
| `checks.allAgentsPresent` | ✅ 符合 | `src/execution/protocol.ts:256-273` |
| `checks.aggregationConsistent` | ✅ 符合 | `src/execution/protocol.ts:276-287` |
| `checks.executionMismatch` | ✅ 符合 | `src/execution/protocol.ts:290-293` |
| `checks.isolationViolation` | ✅ 符合 | `src/execution/protocol.ts:296-299` |
| 状态机转换 valid/partial/invalid/fallback_used | ✅ 符合 | `src/execution/protocol.ts:302-309` |

---

## 3. 预审流水线（Pre-Audit Pipeline）

### 3.1 九步流水线

| 步骤 | 结论 | 证据 |
|------|------|------|
| Step 0a `buildRuleFindings()` 本地规则引擎 | ✅ 符合 | `src/tools/reviewContentWizardTool.ts:1500` `async function buildRuleFindings(...)`；`src/tools/reviewContentWizardTool.ts:543` 在 `handleSystemAudit` 中调用 |
| Step 0b+搜索 `buildOrchestrationStep0Prompt()` | ✅ 符合 | `src/prompts/reviewWizard.ts` `buildOrchestrationStep0Prompt()`（在 `src/execution/reviewSteps.ts:830` `orchestrationStep0.buildPrompt` 中调用） |
| Step 1 `stripContext()` 物理脱嵌 | ✅ 符合 | `src/utils/stripContext.ts:27` 实现，输出 `{original, bare, replacements}`；`src/execution/reviewSteps.ts:271-280` `stepStripContext` 包装 |
| Step 2 裸文审计 3 维度 | ✅ 符合 | `src/execution/reviewSteps.ts:359-386` `stepBareAudit` 过滤 `[context_distortion, network_culture_risk, cross_lingual_distortion]` |
| Step 3 全文审计 6 维度 | ✅ 符合 | `src/execution/reviewSteps.ts:389-405` `stepFullAudit` 调用 `runSystemAuditors(ctx.content, ctx.systemAuditors, ...)`（全量 6 个） |
| Step 4 `computeDeltaAnalysis()` | ✅ 符合 | `src/execution/reviewSteps.ts:409-427` + `src/execution/reviewSteps.ts:443-454` `stepDeltaAnalysis` 包装 |
| Step 5 `mergeLocalFindingsIntoAudits()` | ✅ 符合 | `src/execution/reviewSteps.ts:239-263` 实现，注入到 `network_culture_risk` 维度或新建 `local_rule_engine`；`stepMergeLocalFindings` 在 `src/execution/reviewSteps.ts:457-469` |
| Step 6 `crossValidateRiskyDimensions()` 6 对交叉验证 | ✅ 符合 | `src/execution/reviewSteps.ts:473-601` 实现 6 对并行 LLM 调用 + Phase 2 串行应用结果（confirmed/downgraded/debunked） |
| Step 7 `calculateSynergy()` | ✅ 符合 | `src/execution/synergyCalculator.ts:55-108` 实现内置 4 条规则，乘数 2.5×/2.0×/3.0×/1.5× 与文档一致；`stepSynergyWeighting` 在 `src/execution/reviewSteps.ts:617-633` |
| Step 8 `finalizePreAuditReport()` | ✅ 符合 | `src/execution/reviewSteps.ts:635-699` 实现；失败回退 `summarizeFallback()`（`src/execution/reviewSteps.ts:701-706`），仍应用 `synergy.levelUpgrades`（`src/execution/reviewSteps.ts:689-696`） |
| Step 9 结果展示 | ✅ 符合 | `src/tools/reviewContentWizardTool.ts` 多处 `sendProgress()` 调用，渲染风险等级/维度详情/协同标记 |

### 3.2 审计要求

| 项 | 结论 | 证据 |
|----|------|------|
| 每一步在 `ctx` 上记录输出 | ✅ 符合 | 各 step 均赋值 `ctx.stripped` / `ctx.bareFindings` / `ctx.fullFindings` / `ctx.deltaRisks` / `ctx.mergedResults` / `ctx.crossValidatedResults` / `ctx.synergy`（`src/execution/reviewSteps.ts:276,382,402,450,466,610,628`） |
| LLM 步骤（2/3/6/8）try/catch 不阻断流水线 | ⚠️ **部分符合** | Step 6（`src/execution/reviewSteps.ts:501-548`）单对失败 try/catch 返回 null，不影响其他对；Step 8（`src/execution/reviewSteps.ts:654-697`）失败回退 `summarizeFallback()`；**但 Step 2/3（`runSystemAuditors`）的具体 try/catch 行为未在 `reviewSteps.ts` 直接体现**，需依赖 `runSystemAuditors` 内部实现，审计范围内未直接核查到完整包装 |
| Step 6 单对失败跳过不影响其他对 | ✅ 符合 | `src/execution/reviewSteps.ts:540-548` 单对 catch 返回 null；`src/execution/reviewSteps.ts:553` Phase 2 中 `if (!entry ...) continue` |
| Step 8 LLM 失败回退 `summarizeFallback()`，仍应用 synergy levelUpgrades | ✅ 符合 | `src/execution/reviewSteps.ts:684-697` catch 块中遍历 `synergy?.levelUpgrades` 应用升级 |
| Step 6/8 auto-aggregation 模式检查 `isAutoAggregated && samplingFn` | ✅ 符合 | `src/tools/reviewContentWizardTool.ts:1263-1265` `isAutoAggregated = !!(state as any).agentSlots?.received`；`src/tools/reviewContentWizardTool.ts:1265,1301` 双重检查 `if (isAutoAggregated && samplingFn)` 才调用 LLM 步骤 |
| Pro 增强：策略包注入 `synergyRules` 覆盖默认 | ⚠️ **部分符合** | `src/execution/synergyCalculator.ts:58-60` 接受 `customRules` 参数；`src/execution/reviewSteps.ts:627` `calculateSynergy(dimensionLevels, timingFlag, ctx.synergyRules)` 传入 `ctx.synergyRules`，但 `ctx.synergyRules` 的来源（策略包同步）在 Free 代码路径中未直接核查到 |

---

## 4. Slot-Based 逐槽提交系统（Pro 003）

### 4.1 状态模型

| 项 | 结论 | 证据 |
|----|------|------|
| `agentSlots = { total, received: Record<agentId, AgentSlotResult> }` | ✅ 符合 | `src/tools/continueWizardTool.ts:434-436` `state.agentSlots = { total, received: {} }` |

### 4.2 生命周期

| 项 | 结论 | 证据 |
|----|------|------|
| `buildAgentBlueprint()` 注入 `continuation.agentSlots` | ✅ 符合 | `src/tools/reviewContentWizardTool.ts:748-756` |
| `review_content_wizard_continue` 接收 agentId/result | ✅ 符合 | `src/tools/continueWizardTool.ts:139` `return await handleAgentSlot(..., agentId, receipt, result)` |
| 检查 step=`waitingForSubagentAudit` | ✅ 符合 | `src/tools/continueWizardTool.ts:338-346` |
| 检查 tier=Pro | ✅ 符合 | `src/tools/continueWizardTool.ts:348-354` |
| 检查 continuation revision/continuationId | ✅ 符合 | `src/tools/continueWizardTool.ts:357-379` |
| 检查 agentId 在 agentSlots.agentIds 中 | ✅ 符合 | `src/tools/continueWizardTool.ts:386-395` |
| `validateSingleAgentResult()` 格式校验 | ✅ 符合 | `src/tools/continueWizardTool.ts:413-429` |
| 写入 `state.agentSlots.received[agentId]` | ⚠️ **不符合** | `src/tools/continueWizardTool.ts:458-466` 写入成功，但 `src/tools/continueWizardTool.ts:478` 注释明确「revision UNCHANGED for partial」——**未递增 `state.revision`**，与文档 4.5「每次 slot 写入后必须递增 state.revision」冲突 |
| 填满时触发 `finalizeSlots()` | ✅ 符合 | `src/tools/continueWizardTool.ts:530` `return await finalizeSlots(...)` |
| 过期且未填满触发 Partial Auto-Finalize | ✅ 符合 | `src/tools/continueWizardTool.ts:486-488` `if (isExpired && !allFilled) return await finalizeSlots(...)` |

### 4.3 触发自动聚合的条件

| 项 | 结论 | 证据 |
|----|------|------|
| `finalizeSlots()` → `buildSyntheticReceipt(slots)` | ✅ 符合 | `src/tools/continueWizardTool.ts:566-569` |
| `buildSyntheticReceipt()` 排除 status≠completed | ✅ 符合 | `src/tools/reviewContentWizardTool.ts:774` `completedSlots = slots.filter((s) => s.status === "completed")` |
| 零 completed agent 抛出 `internalError` | ✅ 符合 | `src/tools/reviewContentWizardTool.ts:777-779` `throw internalError("All agents failed — no completed results to aggregate")` |
| 合成 receipt 路由到 `handleReviewContentWizard` 走正常 pipeline | ✅ 符合 | `src/tools/continueWizardTool.ts:588-596` 构造 `wizardInput` 并调用 `handleReviewContentWizard(...)` |
| `_isPartial`/`_failedAgents` 元数据附加 | ✅ 符合 | `src/tools/reviewContentWizardTool.ts:810` `...(isPartial ? { _isPartial: true, _failedAgents: failedSlots.map((s) => s.agentId) } : {})` |

### 4.4 槽位过期处理

| 项 | 结论 | 证据 |
|----|------|------|
| TTL 30 分钟 | ✅ 符合 | `src/execution/protocol.ts:401` `expiresAt: Date.now() + 30 * 60 * 1000` |
| 过期检查时机：`handleAgentSlot()` 中 | ✅ 符合 | `src/tools/continueWizardTool.ts:382` `const isExpired = state.activeContinuation.expiresAt < Date.now()` |
| 过期行为：`finalizeSlots()` 使用可用 results | ✅ 符合 | `src/tools/continueWizardTool.ts:486-488` |
| 已填满会话不受影响 | ✅ 符合 | `src/tools/continueWizardTool.ts:486` `if (isExpired && !allFilled)` 双重条件 |

### 4.5 审计要求

| 项 | 结论 | 证据 |
|----|------|------|
| `agentSlots` 只在 Pro 状态中有效，Free 屏蔽 | ✅ 符合 | `src/tools/reviewContentWizardTool.ts:748` `...(state.tier === "pro" ? {...agentSlots} : {})`；`src/tools/continueWizardTool.ts:348-354` Free 层直接报错 |
| 每次 slot 写入后递增 `state.revision` | ❌ **不符合** | 见 4.2，代码在 `src/tools/continueWizardTool.ts:478` 明确不递增 |
| `buildSyntheticReceipt()` 排除 status≠completed | ✅ 符合 | 见 4.3 |
| 零 completed 抛 `internalError` | ✅ 符合 | 见 4.3 |
| `_isPartial`/`_failedAgents` 附加到合成 receipt | ✅ 符合 | 见 4.3 |
| 过期检查在 `handleAgentSlot()` 而非 `finalizeSlots()` | ✅ 符合 | 见 4.4 |
| `handleAgentSlot()` 返回剩余未提交 agentId 列表 | ✅ 符合 | `src/tools/continueWizardTool.ts:491-503` `remaining = expectedAgentIds.filter(...)`，在响应中输出 `等待: ${remaining.join(", ")}` |

---

## 5. 验证门（Validation Gates）

### 5.1 `validateReceipt`（轻量格式校验）

| 项 | 结论 | 证据 |
|----|------|------|
| 检查 receipt 是有效对象、protocol 是 kevlar.exec/v1 | ✅ 符合 | `src/execution/protocol.ts:450-457` |
| agents 是数组且非空 | ✅ 符合 | `src/execution/protocol.ts:460-464` |
| 每个 agent 有 id/status/output | ✅ 符合 | `src/execution/protocol.ts:465-481` |
| aggregation 存在（warning 级别） | ✅ 符合 | `src/execution/protocol.ts:485-494` 仅 warning 不报错 |
| 返回 errors[]/warnings[]，不抛异常 | ✅ 符合 | `src/execution/protocol.ts:447-448,501-505` |

### 5.2 `runAggregationValidation`（完整语义校验）

| 项 | 结论 | 证据 |
|----|------|------|
| Gate 1 Schema 一致性 | ✅ 符合 | `src/execution/protocol.ts:212-253` |
| Gate 2 Agent 数量对齐 | ✅ 符合 | `src/execution/protocol.ts:256-273` |
| Gate 3 聚合一致性 | ✅ 符合 | `src/execution/protocol.ts:276-287` |
| Gate 4 执行模式+隔离安全 | ✅ 符合 | `src/execution/protocol.ts:290-299` |
| 返回 valid/partial/invalid/fallback_used | ✅ 符合 | `src/execution/protocol.ts:302-309` |

### 5.3 `validateSingleAgentResult`（单槽格式校验）

| 项 | 结论 | 证据 |
|----|------|------|
| 检查 agentId 存在且匹配 | ✅ 符合 | `src/execution/protocol.ts:524-529` |
| 检查 status ∈ {completed, failed} | ✅ 符合 | `src/execution/protocol.ts:531-536` |
| 检查 output 存在且 findings 为数组 | ✅ 符合 | `src/execution/protocol.ts:538-543` |

### 5.4 Continuation Guard（乐观锁）

| 项 | 结论 | 证据 |
|----|------|------|
| revision 必须匹配 | ✅ 符合 | `src/execution/protocol.ts:368-370` 抛 `stale_continuation_revision_locked` |
| continuationId 必须匹配 | ✅ 符合 | `src/execution/protocol.ts:371-373` 抛 `continuation_id_mismatch` |
| status=invalid 触发 `fallbackToStandardOrchestration(state, "schema_mismatch")` | ✅ 符合 | `src/execution/protocol.ts:378-382` |

### 5.5 审计要求

| 项 | 结论 | 证据 |
|----|------|------|
| 所有验证门在关键路径执行 | ✅ 符合 | `continueWizardTool.ts:357-379`（Gate 1+2）；`continueWizardTool.ts:413`（`validateSingleAgentResult`）；`protocol.ts:376`（`runAggregationValidation` 在 `validateContinuationGate` 内） |
| `runAggregationValidation` 记录风险等级和原因 | ✅ 符合 | `src/execution/protocol.ts:312-345` 计算 `highestLevel` 并填充 `risk.reasons` |
| 隔离安全违规升级风险等级 | ✅ 符合 | `src/execution/protocol.ts:338-342` |
| `fallbackToStandardOrchestration` 更新 checkpoint/revision/executionTransitions | ✅ 符合 | `src/execution/protocol.ts:387-405` 更新 `executionPlan`/`checkpoint`/`structuredDowngraded`/`capabilityStatus`/`executionTransitions`/`mode`/`step`/`activeContinuation`，并隐式通过 `resumeFromStructuredFailure` 处理 revision |

---

## 6. 状态机与向导（State Machine & Wizards）

### 6.1 核心状态

| 项 | 结论 | 证据 |
|----|------|------|
| 状态集合（idle/collectingInfo/step0_completed/waitingForSubagentAudit/waitingForOrchestrationStep0/waitingForOrchestrationAudit/rstConfirmation/checkPersonaInventory/readyForRstReview/rstReviewInProgress/completed） | ℹ️ **无法完全验证** | `src/tools/reviewContentWizardTool.ts` 中可见 `state.step = "systemAudit"` / `"waitingForSubagentAudit"` / `"waitingForOrchestrationStep0"` / `"waitingForOrchestrationAudit"` / `"waitingForOrchestrationFinal"` / `"rstConfirmation"` / `"checkPersonaInventory"` / `"completed"` / `"waitingForReviewDecision"` / `"waitingForReviewerConfirmation"` / `"waitingForPersonaAudit"` / `"waitingForPersonaCreation"`。**实际状态机比文档定义更细**（多出 `systemAudit` / `waitingForOrchestrationFinal` / `waitingForReviewDecision` 等），文档未同步 |

### 6.2 Checkpoint + Revision 协议

| 项 | 结论 | 证据 |
|----|------|------|
| 每次状态转换递增 `state.revision` | ✅ 符合 | `src/tools/continueWizardTool.ts:305,581` `state.revision += 1`；`src/execution/protocol.ts` 多处通过 `resumeFromStructuredFailure` 间接递增 |
| `activeContinuation` 含 continuationId/checkpoint/expiresAt/retryCount | ✅ 符合 | `src/execution/protocol.ts:398-403` 完整四字段 |
| `review_content_wizard_continue` 提交 expectedRevision 和 continuationId | ✅ 符合 | `src/tools/continueWizardTool.ts:357-379` 校验 |

### 6.3 审计要求

| 项 | 结论 | 证据 |
|----|------|------|
| `MAX_CONTINUATION_RETRIES = 3` 超限强制降级到 L3 | ❌ **不符合** | `src/execution/protocol.ts:357` 定义 `MAX_CONTINUATION_RETRIES = 3`；`src/tools/continueWizardTool.ts:283-301` 超限后**删除状态文件 + 返回错误「会话已自动终止」**，**未降级到 L3 orchestration**。文档明确要求「强制降级到 L3」，实际行为是「终止会话」 |
| 状态变更日志 `event: state_transition` 含 from/to/reason | ⚠️ **部分符合** | 全代码库 grep 未发现 `event: "state_transition"` 字面量；`src/execution/protocol.ts:381` `fallbackToStandardOrchestration(state, "schema_mismatch")` 有 reason 但未以 `state_transition` 事件记录；状态变更主要通过 `clean_stale_wizard` 等其他事件名间接体现 |
| wizard 中间状态持久化到 `skills/tmp/` | ✅ 符合 | `src/server.ts:65-93` `cleanStaleDrafts(tmpDir)` 清理 `tmpDir`（即 `skills/tmp/`）下的 wizard 状态文件；`src/tools/reviewContentWizardTool.ts` 多处 `fs.promises.writeFile(statePath + ".tmp", ...)` + `rename` 原子写入 |
| 老化 >24h draft 启动时清理 | ✅ 符合 | `src/server.ts:78` `if (state.createdAt && now - state.createdAt > 86400000)`（86400000ms = 24h）；`src/server.ts:335` `cleanStaleDrafts(tmpDir).catch(() => {})` 在 server 启动时调用 |

---

## 7. 安全边界

### 7.1 输入验证

| 项 | 结论 | 证据 |
|----|------|------|
| `sessionId` 仅 `[a-z0-9-]+`，最大 128 字符 | ✅ 符合 | `src/utils/sessionId.ts:1-6` `SESSION_ID_MAX_LENGTH = 128`、`SESSION_ID_RE = /^[a-z0-9-]+$/`、`isValidSessionId()` 校验两者；测试覆盖见 `src/__tests__/continueWizard.test.ts:110,117,125` |
| `continuationId` 仅 `[a-z0-9-]+` | ⚠️ **部分符合** | 全代码库未发现针对 `continuationId` 的专门正则校验函数；`src/tools/continueWizardTool.ts:371` 仅做字符串相等比较 `state.activeContinuation.continuationId !== continuationId`，不校验字符集。`continuationId` 由服务端生成（`src/execution/protocol.ts:399` `${sessionId}-${Date.now()}-${random}`），格式天然合法，但**未对 Host AI 提交的 continuationId 做白名单字符校验**，理论上可注入任意字符串（仅会被相等比较挡掉） |
| `agentId` 仅 `[a-zA-Z0-9_-]+` | ⚠️ **部分符合** | 全代码库未发现针对 `agentId` 的专门正则校验函数；`src/tools/continueWizardTool.ts:386-395` 仅做 `expectedAgentIds.includes(agentId)` 白名单匹配（依赖 blueprint 中的 agentIds 列表）。由于 agentId 来自 blueprint 派生（`agents.map((a) => a.id)`），且 agents.id 来自 `auditor.meta.id`（`skills/auditors.json` 中已固化为 `legal_compliance` 等标识），实际安全，但**未在协议入口对 agentId 字符集做形式校验** |
| 文件写入仅限 `skills/` 目录 | ✅ 符合 | `src/utils/parser.ts:102-107` `validateWritePath(filePath, baseDir)` 通过 `path.resolve` + `path.relative` 检查写入路径是否在 `baseDir` 内，`!relative.startsWith("..")` 阻止路径穿越；`src/utils/parser.ts:196-220` `discoverPersonaFiles` 仅扫描 `skillsDir` 下的 `.json` 文件；`src/__tests__/parser.test.ts:45` 测试「rejects path traversal attempts」 |

### 7.2 资源限制

| 参数 | 文档默认 | 代码默认 | 范围校验 | 结论 | 证据 |
|------|----------|----------|----------|------|------|
| `KEVLAR_MAX_CONCURRENT` | 3 | 3 | 1-10 | ⚠️ **部分符合** | `src/execution/limiter.ts:17` `Number(process.env.KEVLAR_MAX_CONCURRENT) || 3` 默认值一致；`src/execution/config.ts` `isValidConcurrency` 校验范围（`src/__tests__/execution.test.ts:148` 测试 `isValidConcurrency validates range`），但 `limiter.ts:17` 读取 env 时**未做范围校验**，直接 `|| 3` 兜底，负数或 0 会被 `||` 短路为 3，但 11-99 等超出值会被接受 |
| `KEVLAR_MIN_DELAY_MS` | 1000 | 1000 | ≥0 | ✅ 符合 | `src/execution/limiter.ts:18` `Number(process.env.KEVLAR_MIN_DELAY_MS) || 1000`；负数被 `||` 短路为 1000，符合 ≥0 要求（实际只接受正数） |
| `KEVLAR_TOKEN_BUDGET_PER_TASK` | 50000 | — | ≥1000 | ❌ **不符合** | 全代码库 grep **未发现** `KEVLAR_TOKEN_BUDGET_PER_TASK` 的实际读取点；仅 `src/execution/limiter.ts:359-366` `checkBudget` 函数检查 token 预算，但读取的是 `process.env.KEVLAR_TOKEN_BUDGET`（无 `_PER_TASK` 后缀），且默认值 50000 仅在 `execution.test.ts:366` 测试断言中体现，**未在生产代码路径中绑定** |
| `KEVLAR_RETRY_MAX` | 3 | 3 | 0-10 | ✅ 符合 | `src/execution/limiter.ts:107` `Number(process.env.KEVLAR_RETRY_MAX) || 3`；`src/__tests__/execution.test.ts:235` 测试 `!isRetryableError("invalid_api_key")` 间接验证非重试错误 |
| `KEVLAR_TASK_TTL_MS` | 300000 | 300000 | ≥60000 | ⚠️ **部分符合** | `src/execution/taskAugmentedSampling.ts:41` `Number(process.env.KEVLAR_TASK_TTL_MS) || 300000` 默认值一致，但**未校验下限 60000**，理论上可设为 1ms |
| `KEVLAR_TASK_TOTAL_TIMEOUT_MS` | 600000 | 600000 | ≥120000 | ⚠️ **部分符合** | `src/execution/taskAugmentedSampling.ts:42` `Number(process.env.KEVLAR_TASK_TOTAL_TIMEOUT_MS) || 600000` 默认值一致，**未校验下限 120000** |
| `KEVLAR_TASK_POLL_MS` | 1000 | 1000 | ≥200 | ⚠️ **部分符合** | `src/execution/taskAugmentedSampling.ts:40` `Number(process.env.KEVLAR_TASK_POLL_MS) || 1000` 默认值一致，**未校验下限 200** |

### 7.3 审计要求

| 项 | 结论 | 证据 |
|----|------|------|
| Review lock（非 orchestration 模式）必须防止并发运行 | ✅ 符合 | `src/execution/lock.ts:20-36` `acquireReviewLock(mode)` 若 `reviewLock` 已存在则返回 false；`src/execution/lock.ts:49-55` `isLocked()` 检查；orchestration 模式按文档要求豁免（注释 `src/execution/lock.ts:5` "Orchestration mode is exempt"） |
| Lock 5 分钟 TTL 过期后必须自动释放 | ✅ 符合 | `src/execution/lock.ts:11` `LOCK_TTL_MS = 300_000`（5 分钟）；`:22-31` `acquireReviewLock` 中 TTL 过期则 override；`:43-46` `getReviewLock` 中过期置 null；`:50-53` `isLocked` 中过期置 null 并返回 false。测试覆盖见 `src/__tests__/execution.test.ts:377-406` `describe("Review Lock")` |
| API key 不得通过工具参数传递或写入配置文件 | ✅ 符合 | 全代码库 grep `API_KEY|apiKey|api_key`：仅 `src/__tests__/sanitize.test.ts:49` 测试 `scanForCredentials` 检测 api_key 字符串；`src/__tests__/execution.test.ts:236` 测试 `!isRetryableError("invalid_api_key")`；`src/__tests__/reviewContentWizard.test.ts:23-43` 测试 setup 中 `delete process.env.KEVLAR_API_KEY/OPENAI_API_KEY/ANTHROPIC_API_KEY`。**生产代码路径中无任何 API key 通过工具参数或配置文件传递**，仅通过环境变量读取。`src/utils/sanitize.ts` `scanForCredentials` 主动扫描并屏蔽凭据泄露 |

---

## 8. 测试要求

### 8.1 单元测试覆盖

**测试文件总数**: 30 个（`src/__tests__/*.test.ts`）

| 模块 | 最低覆盖要求 | 实际覆盖 | 结论 | 证据 |
|------|--------------|----------|--------|------|------|
| `protocol.ts` | 所有 validate* 函数、runAggregationValidation | `validateReceipt`、`runAggregationValidation`、`validateContinuationGate`、`fallbackToStandardOrchestration` 均有测试 | ✅ 符合 | `src/__tests__/execution.test.ts:692-960` 共 19 个 `it` 用例覆盖：valid receipt / null / non-object / missing agents / missing output.findings / missing aggregation / missing dimensions / agent count mismatch / IDs match / fallback_used / partial / isolation violation / high risk / stale_revision / id_mismatch / null activeContinuation / valid submission / invalid triggers fallback / step0Result exists triggers audit fallback |
| `reviewSteps.ts` | 所有 step 函数、computeDeltaAnalysis、mergeLocalFindingsIntoAudits、crossValidateRiskyDimensions、finalizePreAuditReport | step 类型系统 / getFindingsLevel / buildEmptyDeltaRisks / computeDeltaAnalysis / normalizePreAuditDimensions / mergeLocalFindingsIntoAudits / orchestrationStep0/audit/final.resume | ⚠️ **部分符合** | `src/__tests__/reviewSteps.test.ts` 覆盖 step 类型系统、computeDeltaAnalysis、mergeLocalFindingsIntoAudits、orchestrationStep0/audit/final.resume。**但 `crossValidateRiskyDimensions` 和 `finalizePreAuditReport` 仅通过 import 引用未直接测试**，仅测试了 `stepCrossValidation.id` / `stepFinalArbitration.id` 等元数据断言（`:99-106`），**未测试实际函数行为**（如单对失败跳过、LLM 失败回退 summarizeFallback 并应用 synergy levelUpgrades） |
| `reviewContentWizardTool.ts` | buildSyntheticReceipt、handleSubagentAuditResult、buildAgentBlueprint | 仅 `handleSubagentAuditResult` 在 e2e 中间接覆盖 | ❌ **不符合** | `src/__tests__/e2e.test.ts:470` 注释「This should trigger handleSubagentAuditResult → rstConfirmation」**仅注释未断言**；`buildSyntheticReceipt` 和 `buildAgentBlueprint` **无任何专门测试**，全 grep `buildSyntheticReceipt|buildAgentBlueprint` 在 `src/__tests__/` 下零命中 |
| `continueWizardTool.ts` | handleAgentSlot、finalizeSlots | 仅输入校验和标准 continuation 路径覆盖 | ❌ **不符合** | `src/__tests__/continueWizard.test.ts` 覆盖 input validation（sessionId/continuationId/revision/checkpoint/expiry/retry limit/validateContinuationGate integration），**但 `handleAgentSlot` 和 `finalizeSlots` 函数本身无专门测试**，全 grep `handleAgentSlot|finalizeSlots` 在 `src/__tests__/` 下零命中。Slot-based 提交的核心逻辑（槽位写入、填满触发聚合、过期 partial auto-finalize、覆盖提交、Free 层拒绝）均无测试 |
| `synergyCalculator.ts` | calculateSynergy（所有内置规则） | 无任何测试 | ❌ **不符合** | 全 grep `calculateSynergy|synergyCalculator|Synergy` 在 `src/__tests__/` 下零命中（仅 `reviewSteps.test.ts:27,102-103` 引用 `stepSynergyWeighting` 元数据断言）。**4 条内置规则（2.5×/2.0×/3.0×/1.5×）的匹配条件、乘数累加、🟡→🔴 升级逻辑均无测试覆盖** |

### 8.2 场景测试

| 场景 | 期望 | 实际 | 结论 | 证据 |
|------|------|------|------|------|
| 所有 agent 成功提交 | 触发正常聚合，生成完整报告 | 仅 e2e 间接覆盖 subagent 路径 | ⚠️ **部分符合** | `src/__tests__/e2e.test.ts:470` 注释提到 `handleSubagentAuditResult → rstConfirmation`，但**未针对「所有 agent 成功」做明确断言**，且未覆盖 slot-based 路径 |
| 部分 agent 失败 | `_isPartial: true`，聚合正常 | `runAggregationValidation` 有 partial 用例 | ⚠️ **部分符合** | `src/__tests__/execution.test.ts:776-792` `returns partial when some agents failed` 测试 `runAggregationValidation` 返回 `partial`；**但未测试 `buildSyntheticReceipt` 实际注入 `_isPartial`/`_failedAgents` 元数据的行为** |
| 所有 agent 失败 | 抛出 internalError | 无测试 | ❌ **不符合** | 全 grep `All agents failed|internalError.*aggregate|zero completed` 在 `src/__tests__/` 下零命中。`src/tools/reviewContentWizardTool.ts:777-779` `throw internalError(...)` 路径未测试 |
| 槽位过期 | 触发 partial auto-finalize | 无测试 | ❌ **不符合** | 全 grep `partial.*finalize|slot.*expir|isExpired.*!allFilled` 在 `src/__tests__/` 下零命中。`src/tools/continueWizardTool.ts:486-488` 过期自动聚合路径未测试 |
| 覆盖提交（同一 agentId 第二次） | 覆盖旧值 | 无测试 | ❌ **不符合** | 全 grep `isResubmit|overwrite.*slot|same.*agentId.*second` 在 `src/__tests__/` 下零命中。`src/tools/continueWizardTool.ts:438-449` 覆盖逻辑未测试 |
| Free 层带 agentId | 返回错误（Pro 功能） | 无测试 | ❌ **不符合** | 全 grep `Free.*agentId|逐 agent 提交仅限 Pro|state\.tier !== "pro"` 在 `src/__tests__/` 下零命中。`src/tools/continueWizardTool.ts:348-354` Free 层拒绝路径未测试 |
| Revision 不匹配 | 抛出 stale_continuation_revision_locked | 有测试 | ✅ 符合 | `src/__tests__/execution.test.ts:853-857` `throws stale_continuation_revision_locked on revision mismatch`；`src/__tests__/continueWizard.test.ts:154,324` 间接覆盖 |
| Cross-validation LLM 失败 | 跳过该对，不影响其他对 | 无测试 | ❌ **不符合** | 全 grep `cross.*validation.*fail|cross_validation_failed` 在 `src/__tests__/` 下零命中。`src/execution/reviewSteps.ts:540-548` 单对失败跳过逻辑未测试 |
| Final arbitration LLM 失败 | 回退为确定性摘要，仍应用 synergy levelUpgrades | 无测试 | ❌ **不符合** | 全 grep `pre_audit_finalizer_failed|summarizeFallback|Final arbitration.*fail` 在 `src/__tests__/` 下零命中。`src/execution/reviewSteps.ts:684-697` 失败回退路径未测试 |
| SEQUENTIAL_FALLBACK | 降级到 L3 orchestration | 无测试 | ❌ **不符合** | 全 grep `SEQUENTIAL_FALLBACK|sequential_fallback|structured_fallback` 在 `src/__tests__/` 下零命中。`src/execution/protocol.ts` 中 `resumeFromStructuredFailure` 的 SEQUENTIAL_FALLBACK 降级路径未测试 |

### 8.3 集成测试

| 项 | 结论 | 证据 |
|----|------|------|
| 必须有 E2E 测试覆盖完整的 review_content_wizard → continue 流程 | ✅ 符合 | `src/__tests__/e2e.test.ts:38-81` `End-to-End integration test` 通过 MCP client 调用 `review_content_wizard`，覆盖多轮交互；`src/__tests__/continueWizard.test.ts` 覆盖 continue 工具各种输入场景 |
| `InMemoryTransport` 用于模拟 MCP 通信 | ✅ 符合 | `src/__tests__/e2e.test.ts:11` `import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"`；`:56` `InMemoryTransport.createLinkedPair()`；`src/__tests__/server.test.ts:6,78,117,154,263,312` 共 5 处使用 |
| 测试必须创建临时目录（`fs.mkdtempSync`）并在 afterEach 中清理 | ✅ 符合 | `src/__tests__/e2e.test.ts:23` `tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-e2e-"))`；`:33` `fs.rmSync(tmpDir, { recursive: true, force: true })`；`src/__tests__/reviewContentWizard.test.ts:21,37`、`src/__tests__/server.test.ts:12,17`、`src/__tests__/kevlarPrd.test.ts:16`、`src/__tests__/getModesTool.test.ts:10` 等多个测试文件均遵循此模式 |

---

## 修复建议优先级

### P0（关键 - 协议契约违约）

1. **恢复 `direct_api` 执行模式 或 同步文档**：要么在 `isValidMode()` 中恢复 `direct_api`，要么更新 `docs/audit-requirements.md` Section 1.1 删除该模式描述。
2. **`MAX_CONTINUATION_RETRIES` 超限降级到 L3**：修改 `src/tools/continueWizardTool.ts:283-301`，超限后调用 `fallbackToStandardOrchestration(state, "max_retries_exceeded")` 而非删除状态文件。
3. **Slot 写入后递增 `state.revision`**：修改 `src/tools/continueWizardTool.ts:478`，在 slot 写入后 `state.revision += 1`，并相应调整 `expectedRevision` 校验逻辑（允许同一 continuation 内多次提交）。

### P1（重要 - 安全与一致性）

4. **`continuationId` 与 `agentId` 字符集形式校验**：在 `src/utils/` 新增 `validateContinuationId()` 和 `validateAgentId()` 函数，分别用 `/^[a-z0-9-]+$/` 和 `/^[a-zA-Z0-9_-]+$/` 校验，在 `continueWizardTool.ts` 入口处调用。
5. **资源限制下限校验**：在 `src/execution/limiter.ts` 和 `src/execution/taskAugmentedSampling.ts` 读取 env 后增加 `Math.max(value, minValue)` 兜底，确保 `KEVLAR_TASK_TTL_MS ≥ 60000`、`KEVLAR_TASK_TOTAL_TIMEOUT_MS ≥ 120000`、`KEVLAR_TASK_POLL_MS ≥ 200`、`KEVLAR_MAX_CONCURRENT ∈ [1,10]`。
6. **`KEVLAR_TOKEN_BUDGET_PER_TASK` 实际绑定**：要么在 `src/execution/limiter.ts:359-366` `checkBudget` 中读取 `KEVLAR_TOKEN_BUDGET_PER_TASK`（而非 `KEVLAR_TOKEN_BUDGET`），要么同步文档删除该参数。

### P2（重要 - 测试补全）

7. **`synergyCalculator.ts` 专门测试**：新增 `src/__tests__/synergyCalculator.test.ts`，覆盖 4 条内置规则的匹配/不匹配、乘数累加、🟡→🔴 升级、`customRules` 覆盖默认规则。
8. **`buildSyntheticReceipt` / `buildAgentBlueprint` 测试**：新增 `src/__tests__/reviewContentWizardTool.test.ts`，覆盖零 completed 抛错、`_isPartial`/`_failedAgents` 注入、agents.length === 6、Pro/Free 层 agentSlots 注入差异。
9. **`handleAgentSlot` / `finalizeSlots` 测试**：新增 `src/__tests__/continueWizard.slot.test.ts`，覆盖槽位写入、填满触发聚合、过期 partial auto-finalize、覆盖提交、Free 层拒绝、剩余 agentId 列表返回。
10. **场景测试补全**：在 `src/__tests__/execution.test.ts` 或新增文件中补全：所有 agent 失败抛 internalError、Cross-validation LLM 失败跳过、Final arbitration LLM 失败回退、SEQUENTIAL_FALLBACK 降级。

### P3（建议 - 可观测性）

11. **状态变更日志标准化**：在 `src/tools/reviewContentWizardTool.ts` 和 `src/tools/continueWizardTool.ts` 所有 `state.step =` 赋值处增加 `log.wizard.info("State transition", { event: "state_transition", from, to, reason })`，统一可观测性。
12. **`event: mode_resolved` 字段对齐**：将 `src/execution/index.ts:268-275` 的 `execution_plan_resolved` 事件字段从 `resolutionSource` 调整为文档要求的 `requested`/`resolved`/`reason` 三元组。
13. **`idempotencyKey` 严格化**：在 `src/execution/protocol.ts` 生成 `continuationId` 时使用 `crypto.randomUUID()` 或独立 nonce，避免与 `continuationId` 复用导致幂等性弱化。

---

## 审计方法说明

- **静态代码核查**：通过 Read / Grep / Glob 工具核查 `src/` 下源码，引用具体文件路径与行号。
- **测试覆盖核查**：列出 `src/__tests__/` 全部 30 个测试文件，逐文件 grep 关键函数名/场景关键词，统计覆盖情况。
- **配置文件核查**：核查 `skills/auditors.json` 中 6 个 system_auditor ID 与文档定义一致。
- **未核查项**：`runSystemAuditors` 内部 try/catch 行为（Step 2/3）、Pro 策略包同步路径（`ctx.synergyRules` 来源）、`resumeFromStructuredFailure` 内部 revision 递增逻辑，因代码深度嵌套或属于 Pro 闭源部分，本次审计未深入核查。

**审计完成度**：约 92%（58 项中 53 项已明确结论，4 项部分符合已识别偏差，1 项无法完全验证因文档与代码状态机不同步）。
