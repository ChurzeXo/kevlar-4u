# Kevlar-4u 审计报告

> 审计依据: `docs/audit-requirements.md`
> 审计日期: 2026-06-29
> 总体通过率: **93%** (51/55)

---

## ✅ 通过项（41项）

### §1 执行层

| 需求 | 状态 | 位置 |
|------|------|------|
| 三层降级链（L1 sampling → L2 subagent → L3 orchestration） | ✅ | `src/execution/index.ts:210-265` |
| 模式解析优先级：config → env → auto | ✅ | `src/execution/index.ts:148-176` |
| `getHostStructuredObservation()` 缓存检查 | ✅ | `src/execution/index.ts:238-247` |
| 降级原因记录日志 | ✅ | `src/execution/index.ts:152,157,167` |
| L2 模式输出 AgentBlueprint | ✅ | `src/tools/reviewContentWizardTool.ts:693-759` |
| 事件日志 `event: execution_plan_resolved` | ✅ | `src/execution/index.ts:268-275` |

### §2 协议层

| 需求 | 状态 | 位置 |
|------|------|------|
| AgentBlueprint 协议定义 | ✅ | `src/execution/protocol.ts:15-65` |
| ExecutionReceipt 协议定义 | ✅ | `src/execution/protocol.ts:99-133` |
| AgentSlotResult 协议定义 | ✅ | `src/execution/protocol.ts:71-79` |
| AggregationValidation 协议定义 | ✅ | `src/execution/protocol.ts:137-158` |
| Blueprint agents 数组长度=6 | ✅ | `src/tools/reviewContentWizardTool.ts:703`（`systemAuditors.length`） |
| `agentSlots` 仅 Pro 层生成 | ✅ | `src/tools/reviewContentWizardTool.ts:748-756` |
| Free 层 intercept Pro 协议 | ✅ | `src/tools/continueWizardTool.ts:349-354` |
| 重复 agent 提交允许覆盖 | ✅ | `src/tools/continueWizardTool.ts:439` |
| 失败 agent 不参与聚合 | ✅ | `src/tools/reviewContentWizardTool.ts:774-775` |
| Blueprint continuation.idempotencyKey 传递 | ✅ | `src/tools/reviewContentWizardTool.ts:746` |
| AgentSlot 结果格式校验 | ✅ | `src/execution/protocol.ts:512-550` |

### §3 预审流水线

| 需求 | 状态 | 位置 |
|------|------|------|
| Step 0a 规则引擎 `buildRuleFindings()` | ✅ | 引用在 `reviewContentWizardTool.ts:543` |
| Step 0b 解码 `buildOrchestrationStep0Prompt()` | ✅ | `src/prompts/reviewWizard.ts` |
| Step 1 脱嵌 `stripContext()` | ✅ | `src/utils/stripContext.ts` |
| Step 2 裸文审计（3维并行） | ✅ | `src/execution/reviewSteps.ts:359-385` |
| Step 3 全文审计（6维并行） | ✅ | `src/execution/reviewSteps.ts:389-405` |
| Step 4 Delta 分析 | ✅ | `src/execution/reviewSteps.ts:409-441` |
| Step 5 合并本地发现 | ✅ | `src/execution/reviewSteps.ts:239-263` |
| Step 6 交叉验证（6对双向） | ✅ | `src/execution/reviewSteps.ts:142-179, 473-602` |
| Step 7 协同加权（4条内置规则） | ✅ | `src/execution/synergyCalculator.ts:24-53` |
| Step 8 最终仲裁 + `summarizeFallback()` | ✅ | `src/execution/reviewSteps.ts:635-706` |
| Step 6 失败时跳过该对 | ✅ | `src/execution/reviewSteps.ts:540-548` |
| Step 8 失败时回退确定性摘要 + 保留 synergy | ✅ | `src/execution/reviewSteps.ts:684-698` |
| `isAutoAggregated` 检查 | ✅ | `src/tools/reviewContentWizardTool.ts:1263-1264` |
| Step 0b 联网搜索先例检索 | ✅ | `reviewContentWizardTool.ts:972-1015` |

### §4 Slot 逐槽提交

| 需求 | 状态 | 位置 |
|------|------|------|
| 零 completed agent 抛出 internalError | ✅ | `src/tools/reviewContentWizardTool.ts:777-779` |
| `_isPartial` / `_failedAgents` 元数据 | ✅ | `src/tools/reviewContentWizardTool.ts:810` |
| 过期检查在 `handleAgentSlot()` | ✅ | `src/tools/continueWizardTool.ts:382` |
| 返回剩余未提交 agentId 列表 | ✅ | `src/tools/continueWizardTool.ts:491` |
| `state.revision` 递增 | ✅ | `src/tools/continueWizardTool.ts:581` |
| Slot 填满后自动触发聚合 | ✅ | `src/tools/continueWizardTool.ts:470-472` |

### §5 验证门

| 需求 | 状态 | 位置 |
|------|------|------|
| `validateReceipt()` 轻量格式校验 | ✅ | `src/execution/protocol.ts:446-506` |
| `runAggregationValidation()` 4 Gate 语义校验 | ✅ | `src/execution/protocol.ts:180-352` |
| `validateSingleAgentResult()` | ✅ | `src/execution/protocol.ts:512-550` |
| `validateContinuationGate()` 乐观锁 | ✅ | `src/execution/protocol.ts:359-385` |
| invalid → `fallbackToStandardOrchestration()` | ✅ | `src/execution/protocol.ts:378-382` |
| 隔离安全违规升级风险等级 | ✅ | `src/execution/protocol.ts:338-342` |

### §6 状态机

| 需求 | 状态 | 位置 |
|------|------|------|
| `MAX_CONTINUATION_RETRIES = 3` | ✅ | `src/execution/protocol.ts:357` |
| 超限后清理状态文件 | ✅ | `src/tools/continueWizardTool.ts:285-287` |
| 中间状态持久化到 `skills/tmp/` | ✅ | 所有 handle* 函数均调用 `saveState()` |
| Checkpoint + Revision 协议 | ✅ | `setContinuation()` in `reviewContentWizardTool.ts:282-296` |

### §7 安全

| 需求 | 状态 | 位置 |
|------|------|------|
| `sessionId` 仅 `[a-z0-9-]+` 最大128字 | ✅ | `src/utils/sessionId.ts` |
| Review Lock 5 分钟 TTL | ✅ | `src/execution/lock.ts:11` |
| 非 orchestration 模式防止并发 | ✅ | `src/execution/lock.ts:20-36` |
| API key 不通过工具参数传递 | ✅ | 仅环境变量 |
| 文件写入仅限 `skills/` | ✅ | 路径验证 |

### §8 测试

| 需求 | 状态 | 位置 |
|------|------|------|
| `runAggregationValidation` 测试 | ✅ | `src/__tests__/execution.test.ts:692-828` |
| `validateContinuationGate` 测试 | ✅ | `src/__tests__/execution.test.ts:834-920` |
| `fallbackToStandardOrchestration` 测试 | ✅ | `src/__tests__/execution.test.ts:926-968` |
| E2E 测试 | ✅ | `src/__tests__/e2e.test.ts` |
| InMemoryTransport | ✅ | 在测试框架中使用 |
| 临时目录创建 + 清理 | ✅ | `afterEach` 中清理 |
| `continueWizardTool` 测试 | ✅ | `src/__tests__/continueWizard.test.ts` |

---

## ⚠️ 不通过项（4项）

### 🔴 1. §6.3 — 缺少 `event: state_transition` 日志

**审计需求原文**: 状态变更必须在日志中记录（`event: state_transition`，含 `from`、`to`、`reason`）

**代码检查**: 全代码库搜索 `state_transition` 无结果。`saveState()` 和所有状态机转换位置（`setContinuation()`、`handleSystemAudit()` 等）均未记录此事件。

**影响**: **高** — 无法追溯状态机运行轨迹，影响调试和生产故障排查。

**建议修复**: 在 `setContinuation()` (`reviewContentWizardTool.ts:282`) 和所有显式 `state.step = ...` 位置增加日志调用：

```typescript
logger.info("State transition", {
  event: "state_transition",
  from: prevStep,
  to: state.step,
  reason: checkpoint,
});
```

---

### 🔴 2. §7.1 — `continuationId` 和 `agentId` 缺少格式校验

**审计需求原文**:
- `continuationId`: 仅允许 `[a-z0-9-]+`
- `agentId`: 仅允许 `[a-zA-Z0-9_-]+`

**代码检查**:
- `continuationId` 在 `validateContinuationGate()` (`protocol.ts:371`) 中只做相等比较，不验证格式
- `agentId` 在 `handleAgentSlot()` (`continueWizardTool.ts:387`) 中只检查是否在 `agentSlots.agentIds` 列表中

**影响**: **高** — 无法防范恶意或意外格式的非标准输入。

**建议修复**: 在 `validateContinuationGate()` 和 `handleAgentSlot()` 入口处添加正则校验：

```typescript
if (!/^[a-z0-9-]+$/.test(continuationId)) {
  throw validationError("invalid_continuation_id_format");
}
if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
  throw validationError("invalid_agent_id_format");
}
```

---

### 🟡 3. §8.1 — 缺少 `calculateSynergy` 单元测试

**审计需求原文**: `synergyCalculator.ts` 中 `calculateSynergy`（所有内置规则）必须测试。

**代码检查**: 搜索 `calculateSynergy` 或 `Synergy` 在测试文件中无直接调用。仅在 `continueWizard.test.ts:75` 中 mock 了 `getSynergyRules`。

**影响**: **中** — 4 条内置协同加权规则（含乘数逻辑、🟡→🔴升级逻辑）无回归保护。

**建议修复**: 新建或补充测试覆盖：
- 全部 4 条内置规则的 ALL/ANY condition
- `timing_risk` 附加标记
- `customRules` 覆盖
- 无风险维度的边界情况

---

### 🟡 4. §8.1 — 缺少 `validateSingleAgentResult` 和 `validateReceipt` 单元测试

**审计需求原文**: `protocol.ts` 所有 validate* 函数必须测试。

**代码检查**: `execution.test.ts` 只测试了 `runAggregationValidation` 和 `validateContinuationGate`，未测试 `validateReceipt` 和 `validateSingleAgentResult`。

**影响**: **中** — 轻量格式校验和单槽校验无回归保护。

**建议修复**: 在 `execution.test.ts` 中增加测试：
- `validateReceipt`：null、非对象、缺字段、非法 status、警告分支
- `validateSingleAgentResult`：agentId 不匹配、缺 output、非法 status、接受多字段名

---

## 统计汇总

| 类别 | 总数 | ✅ 通过 | ❌ 不通过 | 通过率 |
|------|------|--------|----------|--------|
| §1 执行层 | 6 | 6 | 0 | 100% |
| §2 协议层 | 11 | 11 | 0 | 100% |
| §3 预审流水线 | 14 | 14 | 0 | 100% |
| §4 Slot 逐槽提交 | 6 | 6 | 0 | 100% |
| §5 验证门 | 6 | 6 | 0 | 100% |
| §6 状态机与向导 | 4 | 3 | 1 | 75% |
| §7 安全边界 | 5 | 4 | 1 | 80% |
| §8 测试要求 | 7 | 5 | 2 | 71% |
| **合计** | **59** | **55** | **4** | **93%** |

**风险分级**:
- 🔴 **高风险**（2 项）: §6.3 状态转换日志缺失、§7.1 输入格式校验缺失
- 🟡 **中风险**（2 项）: `calculateSynergy` 和 `validate*` 函数缺少单元测试
