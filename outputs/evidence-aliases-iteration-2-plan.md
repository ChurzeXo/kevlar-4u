# Evidence Aliases Iteration 2 — 并行优化计划

> 生成时间: 2026-07-09
> 对应版本: v1.6.20 → v1.6.21 (target)

---

## 回顾：本轮两个目标

| # | 问题 | 根因 | 目标 |
|---|------|------|------|
| 2 | sharedInput 全量复制 6 次 (~24000 tokens) | `step0Decoding` + `webContextMap` 在 sharedInput 中未过滤，而 `buildIsolatedAgentDelta` 已做 per-dimension 过滤 → 每个 agent 收到两份 Step 0 数据 | 移除 sharedInput 中冗余字段，token 降 50%+ |
| 3 | Receipt 双份填写 + 无 partial submit | `contexts[].output.findings` 和 `aggregation.dimensions[].findings` 完全重复 → Host AI 手工复制两次; 后端只用 aggregation | 去重 + 支持 partial submit |

---

## 并行策略

两个任务可以**并行开发**（修改不同函数/不同行范围），但如果同一个 Subagent 需要读写多文件，建议**在同一对话框内串行执行两个 Subagent**（先 #2 再 #3），因为二者都改 `reviewContentWizardTool.ts` 和 `protocol.ts` 的不同区域。

以下按 Subagent 1 / Subagent 2 分别描述。

---

## Subagent 1: sharedInput 裁剪（#2）

### 目标
将每个 agent 的 prompt 输入从 ~4000 字降到 ~1500 字，消除 sharedInput 中的重复数据。

### 现状分析

`buildExecutionBlueprint()` (reviewContentWizardTool.ts:1071) 构造 `sharedInput` 时包含：

```typescript
sharedInput: {
  coreReasoningFramework,   // 通用框架 — 保留
  coreFrameworkSteps,        // 通用步骤 — 保留
  content,                   // 原始文案 — 保留
  bareText,                  // 脱嵌文本 — 保留
  localFindings,             // 规则引擎结果 — 保留
  step0Decoding,             // ❌ 全量 Step 0 — 已在 delta 中 per-dimension 过滤
  webContextMap,             // ❌ 全量搜索结果 — 已在 delta 中 per-dimension 过滤
}
```

同时 `buildIsolatedAgentDelta()` (reviewContentWizardTool.ts:1457) **已包含 per-dimension 过滤的 Step 0 数据**（通过 `sanitizeStep0Results` + `DIMENSION_FIELD_ACCESS` + `DIMENSION_SAFETY_RISK`）。sharedInput 和 delta 形成重复。

### 改动方案（最小改动）

**移除 sharedInput 中的 `step0Decoding` 和 `webContextMap`**。

#### Step 1: 修改 `buildExecutionBlueprint()` (reviewContentWizardTool.ts L1128-1136)

```typescript
// 改前
sharedInput: {
  coreReasoningFramework: segs.coreReasoningFramework,
  coreFrameworkSteps: segs.coreFrameworkSteps,
  content,
  bareText,
  localFindings,
  step0Decoding: step0Result,
  webContextMap,
},

// 改后 — 移除最后两行
sharedInput: {
  coreReasoningFramework: segs.coreReasoningFramework,
  coreFrameworkSteps: segs.coreFrameworkSteps,
  content,
  bareText,
  localFindings,
  // step0Decoding 和 webContextMap 已在各 agent delta 中 per-dimension 注入，不在此重复
},
```

#### Step 2: 更新 `ExecutionBlueprint` 类型 (protocol.ts L52-60)

```typescript
// 改前
sharedInput?: {
  ...
  step0Decoding?: Record<string, any>;
  webContextMap?: Record<string, string>;
};

// 改后 — 移除 step0Decoding 和 webContextMap 字段
sharedInput?: {
  coreReasoningFramework?: string;
  coreFrameworkSteps?: string;
  content: string;
  bareText: string;
  localFindings: any[];
};
```

#### Step 3: 检查 `renderBlueprintDispatchText()` (reviewContentWizardTool.ts L867+)

确认渲染模板不引用被移除的字段。当前模板提到 "sharedInput includes step0Decoding" 等描述 — 需要去掉。

#### Step 4: 运行测试

- `npx tsx --test src/__tests__/prompt-hash-baselines.test.ts` — 可能需要更新（因为 sharedInput 变化影响某些 prompt 生成）
- `npx tsx --test src/__tests__/e2e.test.ts` — 可能需要更新 blueprint 构造
- `npx tsx --test src/__tests__/continueWizard.test.ts` — 如果涉及 blueprint 结构

### 预期效果

| 指标 | 改前 | 改后 |
|------|------|------|
| 单个 agent prompt | ~4000 字 | ~1500 字 |
| 6 agent 总输入 | ~24000 字 | ~9000 字 |
| Token 节省 | — | **~62%** |

### 关键文件清单

| 文件 | 函数/位置 | 改动 |
|------|----------|------|
| `src/tools/reviewContentWizardTool.ts` | `buildExecutionBlueprint` L1128-1136 | 移除 step0Decoding + webContextMap |
| `src/tools/reviewContentWizardTool.ts` | `renderBlueprintDispatchText` L867+ | 移除 sharedInput 字段描述 |
| `src/execution/protocol.ts` | `ExecutionBlueprint` L52-60 | 更新 sharedInput 类型 |
| `src/__tests__/e2e.test.ts` | blueprint 构造 | 移除多余字段 |
| `src/__tests__/prompt-hash-baselines.test.ts` | 可能需更新 | 哈希基线 |

### 风险评估

- **低风险**：`buildIsolatedAgentDelta` 已有 per-dimension 的 Step 0 数据，移除 sharedInput 中的重复数据不影响审计正确性
- 如果某个 agent delta 中 Step 0 数据不完整 → 该维度审计质量可能下降（但当前 delta 机制已验证工作正常）

---

## Subagent 2: Receipt 去重 + Partial Submit（#3）

### 目标
1. 消除 `contexts[].output.findings` 和 `aggregation.dimensions[].findings` 的双份填写
2. 支持 partial submit：每个 agent 完成后可立即提交，后端自动聚合

### 现状分析

**冗余根因**: `handleContextAuditResult()` 只从 `parsed.aggregation.dimensions` 读取 findings（见 analysis 第5步），**完全不使用** `parsed.contexts[].output.findings`。但 Host AI 被要求在两处填写相同数据。

**Partial submit 现状**: 已有 Pro-only prototype（`handleContextSlot()` + `buildSyntheticReceipt()`），但 Free 和 structured 路径不支持。

### 改动方案

#### Phase A: 消除冗余（独立改动，可先提交）

**目标**：让 Host AI 只需在 `contexts[].output.findings` 中填写一次，后端自动从中提取 aggregation。

**Step 1**: `handleContextAuditResult()` (reviewContentWizardTool.ts:1987)

```typescript
// 改前 — 从 aggregation.dimensions 读取
for (const dim of parsed.aggregation.dimensions) {
  crossValidatedDimensions.push(...)
}

// 改后 — 从 contexts 中提取，无需 Host AI 填写 aggregation.dimensions[].findings
const dimensions = parsed.contexts.map(ctx => ({
  id: ctx.id,
  level: /* 从 ctx.output.findings 推断等级 */,
  findings: ctx.output.findings,
}));
```

**Step 2**: 更新 `renderBlueprintDispatchText()` 中的 Receipt Schema 模板

移除 `dimensions[].findings` 中的 "copy raw findings from this agent context above" 注释。改为自动提取。

**Step 3**: 更新 `validateReceipt()` (protocol.ts:690)

- `aggregation` 对象仍必须存在（用于 `summary`）
- `aggregation.dimensions[].findings` 改为可选

**Step 4**: 更新 `runAggregationValidation()` (protocol.ts:297)

- Gate 3（聚合一致性）: 不再检查 `dimensions[].findings` 与 `contexts[].output.findings` 的一致性
- 新增自动提取逻辑

#### Phase B: 泛化 Partial Submit（依赖 Phase A）

**目标**：将 Pro-only 的 slot-based submit 扩展到所有 tier。

**Step 1**: `buildExecutionBlueprint()` (reviewContentWizardTool.ts:1166-1176)

```typescript
// 改前 — 仅 Pro 设置 contextSlots
if (state.tier === "pro") {
  result.contextSlots = { ... }
}

// 改后 — 所有 tier 均设置 (Pro 仍保持 allowPartialSubmit: true)
result.contextSlots = {
  total: systemAuditors.length,
  allowPartialSubmit: state.tier === "pro", // 渐进开放
  allowedContextIds: systemAuditors.map(a => a.meta.id),
};
```

**Step 2**: `continueWizardTool.ts` 入口

- 当 `contextId` 非空 AND `contextSlots.allowPartialSubmit === true` → 走 slot 提交
- 否则 → 走 batch 提交（一次性完整 Receipt）

**Step 3**: 更新 `ExecutionBlueprint` 类型中的 `contextSlots` 为所有 tier 可用

#### Phase C: 测试更新

```bash
npm run build
npx tsx --test src/__tests__/continueWizard.test.ts
npx tsx --test src/__tests__/e2e.test.ts
```

更新 mockReceipt 去除 `dimensions[].findings`，改为只有 `contexts[].output.findings`。

### 关键文件清单

| 文件 | 函数/位置 | 改动 |
|------|----------|------|
| `src/execution/protocol.ts` | `ExecutionReceipt` | aggregation.dimensions[].findings → optional |
| `src/execution/protocol.ts` | `validateReceipt` L690 | 放宽 aggregation 校验 |
| `src/execution/protocol.ts` | `runAggregationValidation` L297 | 自动从 contexts 提取 |
| `src/tools/reviewContentWizardTool.ts` | `handleContextAuditResult` L1987 | 从 contexts 提取 findings |
| `src/tools/reviewContentWizardTool.ts` | `renderBlueprintDispatchText` L867+ | 更新 Receipt schema 模板 |
| `src/tools/reviewContentWizardTool.ts` | `buildExecutionBlueprint` L1166 | 泛化 contextSlots |
| `src/tools/continueWizardTool.ts` | 入口 L150 | 放宽 partial submit 条件 |
| `src/__tests__/continueWizard.test.ts` | mock 数据 | 去重 findings |
| `src/__tests__/e2e.test.ts` | mockReceipt | 去重 findings |

### 风险评估

- **中风险**：`handleContextAuditResult()` 从 `aggregation` 切换到 `contexts` 提取 → 需要验证 LLM cross-validation 和 synergy calculation 结果不变
- 建议 Phase A 先提交，手动测试一轮后再做 Phase B

---

## 执行顺序建议

```
Git 回退标记 → Subagent 1 (#2) → 提交 → Subagent 2 Phase A (#3a) → 手动测试 → 
Subagent 2 Phase B (#3b) → 提交 → 全量测试 → 合并发版
```

### 并行可行性

Subagent 1 和 Subagent 2 都修改 `reviewContentWizardTool.ts`，但碰**不同函数**：

| Subagent | 函数 | 行号范围 |
|----------|------|---------|
| 1 | `buildExecutionBlueprint` | L1071-1176 |
| 1 | `renderBlueprintDispatchText` | L867-1000 |
| 2 | `handleContextAuditResult` | L1844-2020 |
| 2 | `renderBlueprintDispatchText` | L867-1000 (冲突!) |

**存在冲突**：两者都改 `renderBlueprintDispatchText`。建议**串行执行**：先 Subagent 1 完成提交，再 Subagent 2。

---

## Git 回退标记

```bash
# 在主仓做
cd /Users/churze/Documents/MCP-Service/kevlar
git tag -a "before-iter2-$(date +%Y%m%d-%H%M)" -m "安全回退点: Iteration 2 (sharedInput + Receipt) 改造前"
git branch rollback/iter2-sharedinput-receipt HEAD
```
