# Kevlar-4u 项目审计报告

> **审计依据**: `docs/audit-requirements.md`（v1.0）
> **审计日期**: 2026-06-29
> **审计范围**: `src/execution/`、`src/tools/`、`src/utils/`、`src/__tests__/`
> **审计结论**: **总体合规**，8 大模块中 6 项完全合规，2 项存在 P1 级偏差需修复

---

## 风险等级汇总

| 等级 | 数量 | 含义 |
|------|------|------|
| 🔴 P0 | 0 | 阻断性问题，必须立即修复 |
| 🟡 P1 | 4 | 与需求明确冲突，影响功能正确性，应尽快修复 |
| 🟢 P2 | 9 | 偏差或代码质量问题，建议修复但不阻断 |

---

## 一、模块审计详情

### 1. 执行层（Execution Layer）— ✅ 合规

**审计文件**: `src/execution/index.ts`、`src/execution/limiter.ts`、`src/execution/client.ts`

| 需求条目 | 状态 | 说明 |
|---------|------|------|
| 1.1 三层降级链 | ✅ | L1 task-augmented sampling → L2 sampling_serial → L3 host_orchestration 完整实现 |
| 1.2 模式解析优先级 | ✅ | config → KEVLAR_MODE env → 自动检测（capability → API key → fallback）顺序正确 |
| 1.3 mode_resolved 日志 | ✅ | `index.ts:272-281` 记录 requested/resolved/reason/backend/strategy/clientFingerprint |
| L2 输出 AgentBlueprint | ✅ | `reviewContentWizardTool.ts:713-789` buildAgentBlueprint 实现 |
| 模式降级记录原因 | ✅ | `mode_silent_downgrade` / `sampling_fallback_to_orchestration` 事件 |
| mcp_subagent 缓存检查 | ✅ | `index.ts:238-243` 调用 `getHostStructuredObservation()` |

**结论**: 执行层完全符合需求。

---

### 2. 协议层（Protocol Layer）— ✅ 基本合规（4 个 P2）

**审计文件**: `src/execution/protocol.ts`

| 需求条目 | 状态 | 说明 |
|---------|------|------|
| 2.1 AgentBlueprint 必填字段 | ✅ | protocol/execution/agents/aggregation/continuation 完整 |
| 2.1 continuation.idempotencyKey | ✅ | `protocol.ts:58` 定义（可选字段，Pro 路径注入） |
| 2.1 agentSlots 仅 Pro 出现 | ✅ | buildAgentBlueprint 通过 tier 判定注入 |
| 2.2 ExecutionReceipt 字段 | ✅ | 全部字段完整 |
| 2.3 AgentSlotResult 字段 | ✅ | agentId/status/submittedAt/output.findings 完整 |
| 2.4 AggregationValidation 四 checks | ✅ | schemaValid/allAgentsPresent/aggregationConsistent/executionMismatch/isolationViolation |

**发现的问题**:

- 🟢 **P2-1** `validateReceipt` 接受 `status: "partial"`（`protocol.ts:491`），但需求 2.2 规定 `agents[].status` 仅允许 `"completed"`/`"failed"`。建议移除 "partial" 或在 warning 中明确提示。
- 🟢 **P2-2** `validateSingleAgentResult` 在 status 不是 completed/failed 时仅 warning 不让 valid=false（`protocol.ts:552-554`），与需求 5.3 的严格性要求不符。建议改为 errors。
- 🟢 **P2-3** `validateSingleAgentResult` 在 output.findings 不是数组时仅 warning（`protocol.ts:560`），与需求 5.3「检查 output.findings 为数组」不符。建议改为 errors。
- 🟢 **P2-4** `runAggregationValidation` 的 executionMismatch 判定（`protocol.ts:290-292`）使用 `requestedMode !== "ephemeral_agents" || actualMode 不是 native/simulated`，与需求 2.4「requestedMode ≠ actualMode」表述不完全一致。在实际使用中因 blueprint.execution.mode 恒为 "ephemeral_agents" 而等价，但表达方式不直观，建议重构为直接比较。

---

### 3. 预审流水线（Pre-Audit Pipeline）— ✅ 合规

**审计文件**: `src/execution/reviewSteps.ts`、`src/utils/stripContext.ts`、`src/tools/reviewContentWizardTool.ts`

| 需求条目 | 状态 | 说明 |
|---------|------|------|
| 3.1 九步流水线 | ✅ | `executeFullPipeline`（`reviewSteps.ts:732-838`）完整实现 Step 1-8 |
| 3.2 Step 0a 规则引擎 | ✅ | `buildRuleFindings`（`reviewContentWizardTool.ts:1530+`）实现 n-gram/L2/multi-hop |
| 3.2 Step 0b 逆向解码 | ✅ | `buildOrchestrationStep0Prompt` 调用点在 696/1221 行 |
| 3.2 Step 1 物理脱嵌 | ✅ | `stripContext`（`stripContext.ts:27`）分割 original/bare/replacements |
| 3.2 Step 2 裸文审计 | ✅ | 3 维度并行（context_distortion/network_culture_risk/cross_lingual_distortion） |
| 3.2 Step 3 全文审计 | ✅ | 6 维度并行 |
| 3.2 Step 4 Delta 分析 | ✅ | `computeDeltaAnalysis`（`reviewSteps.ts:409`）输出 bareOnly/fullOnly/stable |
| 3.2 Step 5 合并本地发现 | ✅ | `mergeLocalFindingsIntoAudits`（`reviewSteps.ts:239`）注入 network_culture_risk |
| 3.2 Step 6 交叉验证 | ✅ | 6 对配置（`CROSS_VALIDATION_PAIRS`），Phase 1 并行 + Phase 2 串行 |
| 3.2 Step 7 协同加权 | ✅ | `calculateSynergy` 4 条内置规则，Pro 支持 customRules 覆盖 |
| 3.2 Step 8 最终仲裁 | ✅ | `finalizePreAuditReport`（`reviewSteps.ts:635`）含 worstCaseNarrative/levelUpgrades |
| 3.3 每步记录到 ctx | ✅ | stripped/bareFindings/fullFindings/deltaRisks/mergedResults/crossValidatedResults/synergy |
| 3.3 LLM 步骤 try/catch | ✅ | Step 2/3 在 `runSystemAuditors` 内（`reviewSteps.ts:333-340`） |
| 3.3 Step 6 失败跳过该对 | ✅ | `crossValidateRiskyDimensions`（`reviewSteps.ts:540-548`）catch 后返回 null |
| 3.3 Step 8 失败回退 | ✅ | `summarizeFallback`（`reviewSteps.ts:701`）+ 仍应用 synergy levelUpgrades（689-696） |
| 3.3 auto-aggregation 检查 | ✅ | `isAutoAggregated && samplingFn` 检查（`reviewContentWizardTool.ts:1293-1331`） |

**结论**: 预审流水线完全符合需求，9 步实现完整且失败处理健壮。

---

### 4. Slot-Based 逐槽提交系统 — ✅ 基本合规（3 个 P2）

**审计文件**: `src/tools/continueWizardTool.ts`、`src/tools/reviewContentWizardTool.ts`

| 需求条目 | 状态 | 说明 |
|---------|------|------|
| 4.1 状态模型 | ✅ | `agentSlots: { total, received: Record<agentId, AgentSlotResult> }` |
| 4.2 生命周期 | ✅ | 创建→提交→验证→写入→填满检查→过期 全流程实现 |
| 4.3 触发自动聚合 | ✅ | `finalizeSlots`（`continueWizardTool.ts:582-642`）→ `buildSyntheticReceipt` → pipeline |
| 4.4 槽位过期 | ✅ | 30min TTL，过期在 `handleAgentSlot` 中检查（406, 530-531） |
| 4.5 agentSlots 仅 Pro | ✅ | `handleAgentSlot:358-363` Free 层直接拒绝 |
| 4.5 revision 递增 | ✅ | 每次 slot 写入后 `state.revision++` |
| 4.5 排除 failed agent | ✅ | `buildSyntheticReceipt` 过滤 `status !== "completed"` |
| 4.5 零 completed 抛 internalError | ✅ | `finalizeSlots:591-603` |
| 4.5 _isPartial/_failedAgents | ✅ | 附加到合成 receipt |
| 4.5 过期检查在 handleAgentSlot | ✅ | `continueWizardTool.ts:406, 530-531` |
| 4.5 返回剩余未提交 agentId | ✅ | 进度提示中包含 |

**发现的问题**:

- 🟢 **P2-5** `isAutoAggregated` 使用 `as any` 绕过类型检查（`reviewContentWizardTool.ts:1293-1294`），而 `ReviewWizardState` 接口（238-241）已正确定义 `agentSlots` 字段。建议移除 `as any`，使用强类型访问。
- 🟢 **P2-6** 死代码：`buildFallbackReport` 函数（`reviewContentWizardTool.ts:1408-1435`）有完整定义但全文件无调用点。实际 Step 8 失败回退在 1346-1366 行内联实现。建议删除或接入。
- 🟢 **P2-7** 过期处理语义不一致：batch 路径过期直接拒绝（`continueWizardTool.ts:282-287`），slot 路径过期则部分聚合（530-531）。需确认是否为设计意图，建议在文档中明确两种路径的过期语义差异。

---

### 5. 验证门（Validation Gates）— ✅ 合规

**审计文件**: `src/execution/protocol.ts`

| 需求条目 | 状态 | 说明 |
|---------|------|------|
| 5.1 validateReceipt | ✅ | 轻量校验，返回 errors + warnings，不抛异常（`protocol.ts:464-524`） |
| 5.2 runAggregationValidation | ✅ | 4 个 Gate 完整（`protocol.ts:180-352`） |
| 5.3 validateSingleAgentResult | ✅ | 检查 agentId/status/output.findings（`protocol.ts:530-568`） |
| 5.4 Continuation Guard | ✅ | revision + continuationId 校验（`protocol.ts:359-391`） |
| 5.5 关键路径执行 | ✅ | validateContinuationGate 在 continueWizardTool 中调用 |
| 5.5 隔离违规升级风险 | ✅ | `protocol.ts:338-342` isolationViolation 升级 risk.level |
| 5.5 fallback 更新状态 | ✅ | `fallbackToStandardOrchestration` 更新 checkpoint/revision/executionTransitions/mode |

**结论**: 验证门完全符合需求。

---

### 6. 状态机与向导 — ⚠️ 有 P1 偏差

**审计文件**: `src/tools/reviewContentWizardTool.ts`、`src/tools/continueWizardTool.ts`、`src/server.ts`

| 需求条目 | 状态 | 说明 |
|---------|------|------|
| 6.1 核心状态 | ✅ | 实现 13 个 step 取值（比文档 10 个多 3 个扩展状态） |
| 6.2 Checkpoint + Revision | ✅ | 每次状态转换递增 revision，activeContinuation 含 continuationId/checkpoint/expiresAt/retryCount |
| 6.3 state_transition 日志 | ✅ | `transitionState` 函数统一记录（reviewContentWizardTool.ts:278-292） |
| 6.3 skills/tmp/ 持久化 | ✅ | wizard 中间状态持久化 |
| 6.3 24h draft 清理 | ✅ | `server.ts:65` cleanStaleDrafts，启动时调用（335 行），有测试覆盖 |

**发现的问题**:

- 🟡 **P1-1** **MAX_CONTINUATION_RETRIES 超限处理与需求不符**
  - **需求 6.3**: 「MAX_CONTINUATION_RETRIES = 3，超限后必须**强制降级到 L3**」
  - **实现**（`continueWizardTool.ts:289-310`）: 超限后**删除状态文件**并返回错误「会话已自动终止」，要求用户重新发起评测
  - **影响**: 需求期望系统在重试耗尽后自动降级到 L3 orchestration 继续工作，实现却是直接终止会话。这导致用户在宿主 AI 能力不足时无法获得降级后的审计结果，体验中断。
  - **建议修复**: 超限后调用 `fallbackToStandardOrchestration(state, "max_retries_exceeded")` 降级到 L3，而非删除状态文件。

---

### 7. 安全边界 — ✅ 基本合规（2 个 P2）

**审计文件**: `src/utils/sessionId.ts`、`src/utils/sanitize.ts`、`src/utils/parser.ts`、`src/execution/lock.ts`、`src/execution/limiter.ts`、`src/execution/config.ts`

| 需求条目 | 状态 | 说明 |
|---------|------|------|
| 7.1 sessionId 校验 | ✅ | `/^[a-z0-9-]+$/`，最大 128 字符（`sessionId.ts`） |
| 7.1 continuationId 校验 | ✅ | `/^[a-z0-9-]+$/`（`protocol.ts:368`、`continueWizardTool.ts:367`） |
| 7.1 agentId 校验 | ✅ | `/^[a-zA-Z0-9_-]+$/`（`continueWizardTool.ts:409`） |
| 7.1 文件写入仅限 skills/ | ✅ | `validateWritePath`（`parser.ts:102-107`）做路径遍历防护，有测试覆盖 |
| 7.2 资源限制参数 | ✅ | 7 个参数全部有默认值 |
| 7.3 Review lock 5min TTL | ✅ | `lock.ts:11` LOCK_TTL_MS = 300_000，acquire/get/isLocked 均检查 TTL |
| 7.3 Lock 自动释放 | ✅ | TTL 过期后自动释放 |
| 7.3 API key 不写入配置 | ✅ | `sanitize.ts` KEY_PATTERNS 检测 + sanitizeOutput redact |

**发现的问题**:

- 🟢 **P2-8** 资源限制范围 clamp 不一致：`config.ts:90` 有 `isValidConcurrency` 校验（1-10 范围），但 `limiter.ts:17` 直接 `Number(process.env.KEVLAR_MAX_CONCURRENT) || 3` 无范围 clamp。若用户设置 `KEVLAR_MAX_CONCURRENT=20`，limiter 会用 20，但 config.ts 会忽略。两处不一致，可能导致限制失效。
- 🟢 **P2-9** 其他参数（`KEVLAR_MIN_DELAY_MS`、`KEVLAR_RETRY_MAX`、`KEVLAR_TASK_TTL_MS` 等）在 `limiter.ts`/`taskAugmentedSampling.ts` 也没有范围 clamp，与需求 7.2 定义的范围（如 KEVLAR_TASK_TTL_MS ≥60000）不符。

---

### 8. 测试要求 — ⚠️ 有覆盖缺口（3 个 P1 + 2 个 P2）

**审计文件**: `src/__tests__/*.ts`

#### 8.1 单元测试覆盖

| 模块 | 需求覆盖 | 实际状态 |
|------|---------|---------|
| `protocol.ts` | 所有 validate* + runAggregationValidation | ✅ `execution.test.ts` 30+ 测试完整覆盖 |
| `reviewSteps.ts` | 所有 step + computeDeltaAnalysis + merge + crossValidate + finalize | ⚠️ 部分：computeDeltaAnalysis ✅、merge ✅、orchestration resume ✅；**crossValidateRiskyDimensions 和 finalizePreAuditReport 无直接单元测试** |
| `reviewContentWizardTool.ts` | buildSyntheticReceipt + handleSubagentAuditResult + buildAgentBlueprint | ⚠️ buildAgentBlueprint ✅（`reviewContentWizard.test.ts:551-695`）；**buildSyntheticReceipt 和 handleSubagentAuditResult 无直接单元测试** |
| `continueWizardTool.ts` | handleAgentSlot + finalizeSlots | ⚠️ handleAgentSlot ✅（`continueWizard.test.ts:638-829`）；**finalizeSlots 无直接测试**，仅通过 slot 流程间接覆盖 |
| `synergyCalculator.ts` | calculateSynergy 所有内置规则 | ✅ `synergyCalculator.test.ts` 全面覆盖（4 规则 + 自定义 + 边界） |

#### 8.2 场景测试覆盖

| 场景 | 期望 | 状态 | 测试位置 |
|------|------|------|---------|
| 所有 agent 成功提交 | 触发正常聚合 | ✅ | `continueWizard.test.ts:758` + `e2e.test.ts:374` |
| 部分 agent 失败 | _isPartial: true | ✅ | `continueWizard.test.ts:818` |
| 所有 agent 失败 | 抛出 internalError | ❌ | **无显式测试** |
| 槽位过期 | 触发 partial auto-finalize | ⚠️ | 仅 batch 路径过期拒绝（`continueWizard.test.ts:233`），**slot 路径 partial auto-finalize 未测试** |
| 覆盖提交 | 覆盖旧值 | ✅ | `continueWizard.test.ts:785` |
| Free 层带 agentId | 返回错误 | ✅ | `continueWizard.test.ts:686` |
| Revision 不匹配 | 抛 stale_continuation_revision_locked | ✅ | `continueWizard.test.ts:154` + `execution.test.ts:855` |
| Cross-validation LLM 失败 | 跳过该对 | ❌ | **无显式测试** |
| Final arbitration LLM 失败 | 回退确定性摘要 | ❌ | **无显式测试** |
| SEQUENTIAL_FALLBACK | 降级到 L3 | ✅ | `continueWizard.test.ts:370` + `execution.test.ts:889` |

**发现的问题**:

- 🟡 **P1-2** 需求 8.2 场景「所有 agent 失败 → 抛出 internalError」无显式测试。`finalizeSlots:591-603` 的零 completed agent 检查未被测试覆盖。
- 🟡 **P1-3** 需求 8.2 场景「Cross-validation LLM 失败 → 跳过该对」无显式测试。`crossValidateRiskyDimensions` 的失败路径（`reviewSteps.ts:540-548`）未被测试。
- 🟡 **P1-4** 需求 8.2 场景「Final arbitration LLM 失败 → 回退确定性摘要」无显式测试。`finalizePreAuditReport` 的 catch 分支（`reviewSteps.ts:684-698`）未被测试。
- 🟢 **P2-10** 需求 8.2 场景「槽位过期 → partial auto-finalize」覆盖不完整。
- 🟢 **P2-11** 需求 8.1 `crossValidateRiskyDimensions`、`finalizePreAuditReport`、`buildSyntheticReceipt`、`handleSubagentAuditResult`、`finalizeSlots` 缺少直接单元测试。

#### 8.3 集成测试

| 需求 | 状态 | 说明 |
|------|------|------|
| E2E 覆盖完整流程 | ✅ | `e2e.test.ts` 4 个测试用例覆盖 Free/Pro 流程 |
| InMemoryTransport | ✅ | `e2e.test.ts:11, 56, 247, 407, 613` |
| 临时目录 + afterEach 清理 | ✅ | `e2e.test.ts:23` mkdtempSync + `:32` afterEach |

**结论**: 集成测试合规，但单元测试和场景测试有 3 个 P1 级覆盖缺口。

---

## 二、问题汇总与修复优先级

### P1 级问题（应尽快修复）

| # | 模块 | 问题 | 建议修复 |
|---|------|------|---------|
| P1-1 | 状态机 | MAX_CONTINUATION_RETRIES 超限删除状态而非降级到 L3 | `continueWizardTool.ts:292-310` 改为调用 `fallbackToStandardOrchestration(state, "max_retries_exceeded")` |
| P1-2 | 测试 | 「所有 agent 失败 → internalError」无测试 | 新增 `continueWizard.test.ts` 测试：6 个 agent 全部 status="failed"，验证抛出 internalError |
| P1-3 | 测试 | 「Cross-validation LLM 失败」无测试 | 新增 `reviewSteps.test.ts` 测试：mock samplingFn 抛错，验证该对跳过、其他对正常 |
| P1-4 | 测试 | 「Final arbitration LLM 失败」无测试 | 新增 `reviewSteps.test.ts` 测试：mock caller 抛错，验证回退 summarizeFallback + 仍应用 levelUpgrades |

### P2 级问题（建议修复）

| # | 模块 | 问题 |
|---|------|------|
| P2-1 | 协议层 | `validateReceipt` 接受 status="partial"，与需求 2.2 冲突 |
| P2-2 | 协议层 | `validateSingleAgentResult` status 非法时仅 warning |
| P2-3 | 协议层 | `validateSingleAgentResult` output.findings 非数组时仅 warning |
| P2-4 | 协议层 | `runAggregationValidation` executionMismatch 判定逻辑不直观 |
| P2-5 | Slot 系统 | `isAutoAggregated` 使用 `as any` 绕过类型检查 |
| P2-6 | Slot 系统 | `buildFallbackReport` 死代码无调用点 |
| P2-7 | Slot 系统 | batch/slot 过期处理语义不一致 |
| P2-8 | 安全边界 | limiter.ts 资源限制无范围 clamp，与 config.ts 不一致 |
| P2-9 | 安全边界 | 多个 env 参数无范围 clamp |
| P2-10 | 测试 | 槽位过期 partial auto-finalize 覆盖不完整 |
| P2-11 | 测试 | 5 个关键函数缺少直接单元测试 |

---

## 三、合规性总结

| 模块 | 合规度 | P1 | P2 |
|------|--------|----|----|
| 1. 执行层 | ✅ 完全合规 | 0 | 0 |
| 2. 协议层 | ✅ 基本合规 | 0 | 4 |
| 3. 预审流水线 | ✅ 完全合规 | 0 | 0 |
| 4. Slot 系统 | ✅ 基本合规 | 0 | 3 |
| 5. 验证门 | ✅ 完全合规 | 0 | 0 |
| 6. 状态机 | ⚠️ 有偏差 | 1 | 0 |
| 7. 安全边界 | ✅ 基本合规 | 0 | 2 |
| 8. 测试要求 | ⚠️ 有缺口 | 3 | 2 |
| **合计** | — | **4** | **11** |

**总体评价**: Kevlar-4u 项目核心架构（三层降级链、九步流水线、协议契约、Slot 系统、验证门）实现完整且健壮，失败处理和降级机制设计合理。主要问题集中在 **状态机重试超限处理与需求不符**（P1-1）和 **测试覆盖缺口**（P1-2/3/4）。建议优先修复 P1 级问题，P2 级问题可在后续迭代中处理。

---

*报告生成时间: 2026-06-29 21:50 GMT+8*
