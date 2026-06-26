# Kevlar 审计修复进度

基于 `docs/audit-report-2026-06-26.md`（QoderWork 60 项审计）与 OpenCode 补充审计的交叉对比。

## 修复路线图

```
P0 (立即) ──→ P1 (短期) ──→ P2 (中期/目标架构) ──→ P3 (收尾)
  ✅ 已完成     ✅ 已完成        ✅ 已完成              ✅ 已完成
```

---

## ✅ P0 — 已完成 (2026-06-27)

| # | 项目 | 文件 | 变更 |
|---|------|------|------|
| P0-1 | `Promise.all()` 全局超时 | `reviewSteps.ts`, `parallel.ts` | `Promise.race([Promise.all(...), timeoutPromise])`，消费 `config.multiAgent.timeoutMs` |
| P0-2 | 降级转换结构化日志 | `checkpoint.ts`, `protocol.ts` | `resumeFromStructuredFailure()` + `fallbackToStandardOrchestration()` 各自添加 `logger.warn("Execution downgraded", { event: "execution_downgraded" })` |

---

## ✅ P1 — 已完成

| # | 项目 | 文件 | 变更 |
|---|------|------|------|
| P1-1 | Step 6 交叉验证并行化 | `reviewSteps.ts` | 两阶段设计: Phase 1 `Promise.all()` 并行 LLM 调用，Phase 2 串行写回（避写冲突） |
| P1-2 | MCP 错误码分类 | `parallel.ts`, `aggregator.ts` | `-1` → `addSkipped()`; `-32602` → ignore; 新增 skipped 列表 |
| P1-3 | riskLevel 归一化 | `riskLevel.ts`(新), `aggregator.ts`, `protocol.ts` | `normalizeRiskLevel()` 统一 🔴/high/red/高 → `"🔴"` |
| P1-4 | 能力检测扩展 | `client.ts` | `isTaskAugmentedSamplingSupported()` + `isTaskCancelSupported()` |

---

## ✅ P2 — 已完成 (2026-06-27)

### P2a: 类型扩展 + 环境开关

| # | 项目 | 文件 | 变更 |
|---|------|------|------|
| P2-1 | `ExecutionBackend` 扩展 | `plan.ts`, `base.ts`, `config.ts` | 新增 `"sampling_serial"` / `"sampling_task_augmented"`；`ExecutionPlan` 联合类型扩展；`ExecutionMode` 加 `"mcp_sampling"` |
| P2-5 | `KEVLAR_ENABLE_TASK_AUGMENTED` | `index.ts` | `resolveExecutionPlan()` 自动解析时检查此 flag，默认启用（`!== "0"`） |

### P2b: 核心实现

| # | 项目 | 文件 | 变更 |
|---|------|------|------|
| P2-2 | task-augmented 采样核心 | `taskAugmentedSampling.ts` **(新，344 行)** | `sampling/createMessage` 带 `task: { ttl }` → 并行发射 N 个任务 → `tasks/get` 轮询 → `tasks/result` 阻塞取结果 |
| P2-3 | 5 状态机 | 同上 | `working` / `input_required` / `completed` / `failed` / `cancelled` 全覆盖；elicitation 处理；总超时 600s |
| P2-7 | related-task 元数据 | 同上 | `tasks/result` 调用 MUST 携带 `_meta: { "io.modelcontextprotocol/related-task": { taskId } }`；`tasks/get` 不携带 |
| P2-4 | 完整降级链 | `samplingExecution.ts` **(新，102 行)** + `index.ts` | `executeReview()` 管线: task-augmented → serial sampling → host_orchestration；`executeSamplingReview()` 统一入口 |
| P2-6 | 状态文件原子化 | `continueWizardTool.ts` | 所有 wizard state write 改为 `.tmp` + `rename`（`reviewContentWizardTool.ts` 已有此模式） |

### 新增文件清单

```
src/execution/riskLevel.ts              — P1-3 normalizeRiskLevel()
src/execution/taskAugmentedSampling.ts  — P2-2/P2-3/P2-7 核心实现 (344 行)
src/execution/samplingExecution.ts      — P2-4 统一采样入口 + 降级链 (102 行)
```

### 降级链最终状态

```
L1: sampling_task_augmented  (KEVLAR_ENABLE_TASK_AUGMENTED + tasks.requests.sampling.createMessage)
  │  失败/未声明 → 自动降级
  ▼
L2: sampling_serial          (capabilities.sampling !== undefined)
  │  失败/未声明 → 自动降级
  ▼
L3: host_orchestration/structured (kevlar.host.execution/v1, observation cache guided)
  │  失败/unsupported → 运行时降级
  ▼
L4: host_orchestration/standard   (priority 30, canExecute() === true) ← 最终兜底
```

每级降级均输出: `event: "execution_downgraded"` 结构化日志。

---

## 变更文件总览

```
修改 (16 files):
  src/execution/base.ts               — ExecutionContext + server
  src/execution/checkpoint.ts         — P0-2 降级日志
  src/execution/client.ts             — P1-4 能力检测
  src/execution/config.ts             — P2-1 isValidMode
  src/execution/index.ts              — P2-1/P2-4/P2-5 执行计划 + 降级链
  src/execution/limiter.ts             — P3-1 RateLimiter 优化
  src/execution/parallel.ts           — P0-1 超时 + P1-2 错误码
  src/execution/plan.ts               — P2-1 类型扩展
  src/execution/protocol.ts           — P0-2 降级日志 + P1-3 风险归一化
  src/execution/reviewSteps.ts        — P0-1 超时 + P1-1 并行化
  src/execution/aggregator.ts         — P1-2 skipped + P1-3 风险归一化
  src/tools/continueWizardTool.ts     — P2-6 原子写
  src/tools/reviewContentWizardTool.ts — 已有原子写, subagent 自动扩展
  src/__tests__/e2e.test.ts           — subagent 自动扩展
  src/__tests__/reviewContentWizard.test.ts — subagent 自动扩展

新增 (3 files):
  src/execution/riskLevel.ts          — P1-3
  src/execution/taskAugmentedSampling.ts — P2-2/P2-3/P2-7
  src/execution/samplingExecution.ts  — P2-4
```

---

## ✅ P3 — 已完成 (2026-06-27)

审计报告中 P0/P1/P2 未覆盖的 PARTIAL/FAIL 收尾项。

| # | 项目 | 文件 | 变更 |
|---|------|------|------|
| P3-1 | RateLimiter `minDelayMs` 优化 | `limiter.ts` | `waitForDelay()` 仅在 `activeCount >= maxConcurrent` 时执行延迟。低于并发上限时跳过 → 消除 Stage 2 RST 不必要的 1000ms 等待 |
| P3-2 | validateReceipt / runAggregationValidation 边界澄清 | `protocol.ts` | 两者均添加完整 JSDoc：`validateReceipt()` 标注为轻量格式预检，`runAggregationValidation()` 标注为后执行权威校验。`validateReceipt()` 返回 warnings 中推荐调用后者 |

---

## 两轮审计差异最终状态

| 发现点 | QoderWork | OpenCode | 最终状态 |
|--------|-----------|----------|----------|
| Step 6 串行瓶颈 | ✅ | ❌ | ✅ P1-1 |
| timeoutMs 闲置 | ✅ | ❌ | ✅ P0-1 |
| 降级零日志 | ✅ | ⚠️ | ✅ P0-2 |
| riskLevel 显示层混用 | ✅ | ❌ | ✅ P1-3 |
| MCP 错误码未分类 | ✅ | ❌ | ✅ P1-2 |
| 能力检测不足 | ✅ | ✅ | ✅ P1-4 |
| RateLimiter 瓶颈 | ✅ | ❌ | 暂缓 |
| executeReview 丢弃 mode | ❌ | ✅ | ✅ P2-4 |
| TOCTOU 竞态 | ⚠️ | ✅ | ✅ P2-6 |
| related-task 元数据 | ✅ | ✅ | ✅ P2-7 |
| task-augmented 全线缺失 | ✅ | ✅ | ✅ P2-2/P2-3 |
| validateReceipt 职责不清 | ✅ | ❌ | ✅ P3-2 |

---

## 执行命令

```bash
# 编译检查
npx tsc --noEmit                        # ✅ 零错误

# 全量测试
npm test                                # 预期: 433 pass / 0 fail

# 启用 task-augmented (需 MCP Client 支持)
KEVLAR_ENABLE_TASK_AUGMENTED=1 npm run dev

# 禁用 task-augmented (仅用 serial sampling / orchestration)
KEVLAR_ENABLE_TASK_AUGMENTED=0 npm run dev
```
