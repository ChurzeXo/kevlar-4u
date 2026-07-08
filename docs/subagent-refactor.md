# 宿主编排 → Task+Subagent 调度 重构方案

## 概述

将 `orchestration` 兜底模式中**系统初审（Pro）**的 LLM 推理步骤从"单 prompt 角色扮演"升级为 opencode Task+Subagent 并行调度，实现**真隔离 + 真并行**，同时**不改动任何现有提示词**。

核心思路：从 MCP 协议层面，kevlar 返回的仍是文本 prompt，但 prompt 写法从"角色扮演式"改为"调度式"——教宿主 AI 用它的 Task 工具派发 subagent。

> 注：RST复审（Free）是独立模块，其 orchestration 改造不在本文档范围内，可后续单独推进。

---

## Free / Pro 分层（现状）

```
系统初审（Pro 独占）                     RST复审（Free 独占）
═══════════════════════                  ═══════════════════
  local_rules                              rst_review
  orchestration_step0
  strip_context
  bare_audit
  full_audit
  delta_analysis
  merge_local_findings
  cross_validation
  synergy_weighting
  final_arbitration
  display
```

**关键事实**（来源 `docs/README.zh.md:68-82` + `src/execution/strategy.ts:58-105`）：

- `FREE_PLAN`：`steps: ["rst_review"]`，**只有 RST复审**，无初审步骤。Free 用户直接进入人设选择 + RST复审。
- `PRO_PLAN`：`steps: ["local_rules", ..., "display"]`，**只有系统初审**，无 `rst_review` 步骤。
- **两者是独立产品模块**——系统初审是 Pro 功能，RST复审是 Free 功能，互不依赖。

本次重构**仅涉及系统初审（Pro）的 orchestration 子模式**。

---

## 当前架构 vs 目标架构

```
当前 orchestration（3 轮 MCP 往返）:
═══════════════════════════════════════════════════════════════════════
  Turn 1: buildOrchestrationStep0Prompt()     → 宿主推理 → 返回 JSON
          [code: Step 0a 规则引擎, Step 1 脱嵌]
  Turn 2: buildOrchestrationAuditPrompt()      → 宿主填 6 沙盒 → 返回 JSON
          [code: Step 5 合并, Step 7 协同]
  Turn 3: buildOrchestrationFinalizerPrompt()  → 宿主交叉验证+仲裁 → 返回 JSON
          [code: Step 9 展示]


目标（1 次 MCP 往返 + 宿主内部 subagent 并行）:
═══════════════════════════════════════════════════════════════════════
  kevlar → 调度 prompt → opencode primary:
    1. 调 kevlar 工具拿 Step 0a 规则结果 + Step 1 脱嵌文本
    2. 启动 Step 0b subagent（含联网搜索），拿到 step0Result + webContextMap
    3. 并行启动 6 个维度 subagent，注入 buildIsolatedSystemAuditorPrompt()
    4. 收结果 → kevlar 在 handleSubagentAuditResult() 中执行：
       Step 4 (delta) → Step 5 (merge) → Step 6 (cross-validation, fallback)
       → Step 7 (synergy) → Step 8 (final arbitration, fallback)
    5. 返回最终报告
```

> **实现状态**：Step 4/5/6/7/8 已在 `handleSubagentAuditResult()` 中实现（commit `5f4e2bd`）。
> Step 6/8 在没有 `caller`（无 samplingFn 且无 API key）时跳过，依赖宿主在 subagent
> 调度 prompt 中完成。后续可考虑在无 caller 时也通过宿主 subagent 派发这两步。

---

## 并行/串行依赖分析

从 `src/execution/reviewSteps.ts`（`executeFullPipeline()`）追踪数据依赖：

```
Phase A ─────────────────────────────────────────────────────────────
  │  Step 0a (code, rule engine)  ∥  Step 1 (code, stripContext)
  │  产出: localFindings[]             产出: { original, bare, replacements }
  │  依赖: content only                依赖: content only
  │  两者无数据依赖 → 可并行
  │
  │  注：实际代码中 Step 1 先于 Step 0b 执行（`handleSystemAudit()` L524），
  │      但 Step 0b 和 Step 1 无数据依赖，先后顺序不影响正确性。
  │
  │
  ▼
Phase B ─────────────────────────────────────────────────────────────
  │  Step 0b (subagent) ← 需要 0a 的 localFindings
  │  产出: step0Result { wildTranslations, blackAtoms, attackCandidates }
  │       + webContextMap + precedents
  │  包含：语言边界判定 → 风险原子提取 → 情绪重构 → 联网搜索
  │  ⚠️  联网搜索必须保留：宿主 subagent 使用自己的 web search 工具
  │      对每个 blackAtom 搜索中文网络语境 + 检索类似舆情翻车先例
  │
  ▼
Phase C ─────────────────────────────────────────────────────────────
  │  6 个维度 subagent 并行（每个维度独立 context window）
  │  ← 需要 0b 的 step0Result + webContextMap + 1 的 text
  │
  │  Subagent #1: legal_compliance        (CoT: 广告法扫描)
  │  Subagent #2: social_risk             (CoT: 感官词组合检测)
  │  Subagent #3: context_distortion      (CoT: 跨平台语义测试 + 裸文)
  │  Subagent #4: network_culture_risk    (CoT: 黑话/谐音/缩写检测 + 裸文)
  │  Subagent #5: factual_integrity       (CoT: 数据验证)
  │  Subagent #6: cross_lingual_distortion(CoT: 野生翻译/谐音梗 + 裸文)
  │
  │  注：3 个标注"裸文"的维度同时接收 bare + full 文本，产出双份 findings
  │      供 Phase D delta 分析使用
  │
  ▼
Phase D ─────────────────────────────────────────────────────────────
  │  Step 4 (code, delta)  →  Step 5 (code, merge)
  │  需要: 6 个 subagent 输出     需要: subagent fullFindings + 0a localFindings
  │  两者无数据依赖（设计上可并行），当前实现中串行执行
  │  （`handleSubagentAuditResult()` L846→L885）
  │
  ▼
Phase E ─────────────────────────────────────────────────────────────
  │  Step 6 (subagent, cross-validation)
  │  ← 需要 Step 5 的 mergedResults
  │  执行 6 对定向/双向互验（`reviewSteps.ts:133-170`）：
  │    1. network_culture_risk → context_distortion
  │    2. context_distortion → network_culture_risk
  │    3. social_risk → factual_integrity
  │    4. legal_compliance → social_risk
  │    5. cross_lingual_distortion → network_culture_risk
  │    6. network_culture_risk → cross_lingual_distortion
  │
  ▼
Phase F ─────────────────────────────────────────────────────────────
  │  Step 7 (code, synergy) ← 需要 Step 6 crossValidatedResults + 0a timingFlag
  │  产出: synergy { triggered[], overallMultiplier, levelUpgrades[] }
  │
  ▼
Phase G ─────────────────────────────────────────────────────────────
  │  Step 8 (subagent, final arbitration)
  │  ← 需要: Step 5 mergedResults + Step 6 crossValidatedResults 
  │        + Step 7 synergy + Step 4 deltaRisks + Step 0b precedents
  │  执行: 去重 → 攻击链放大 → 最终定级 → synergy 升级应用 → worstCaseNarrative
  │
  ▼
Phase H ─────────────────────────────────────────────────────────────
  │  Step 9 (code, display)
  │  组装 PreAuditReport → 展示给用户
```

### 并行度汇总

| Phase | 执行体 | 并行数 | 类型 |
|---|---|---|---|
| A | Step 0a ∥ Step 1 | 2 | 代码 |
| B | Step 0b | 1 | Subagent |
| C | 6 维度审计 | **6** | Subagent |
| D | Step 4 → Step 5 | — | 代码 |
| E | Step 6 | 1 | Subagent |
| F | Step 7 | 1 | 代码 |
| G | Step 8 | 1 | Subagent |
| H | Step 9 | 1 | 代码 |

**关键收益**：Phase C 从串行 6 沙盒 → 6 个并行 subagent，耗时从 O(6×T) → O(T)。Phase A 中 Step 0a 和 Step 1 可并行（代码层面同时执行）。

---

## 结果聚合设计

Subagent 模式下，6 个维度审计 subagent 并行执行，每个返回独立结果。需要明确聚合机制。

### Subagent 输出格式约束

每个维度 subagent 必须返回**结构化 JSON**。实际格式（与 `buildSubagentDispatchPrompt()` 中规定的格式一致，见 `src/prompts/reviewWizard.ts:1089-1096`）：

```json
{
  "id": "legal_compliance",
  "name": "合规哨兵",
  "findings": [],
  "level": "🟢"
}
```

> **注意**：文档早期版本描述了逐条 finding 的详细结构（`auditorId` / `riskId` / `severity` 等），但与实际实现不符。实际聚合逻辑在 `handleSubagentAuditResult()` 中通过 `normalizePreAuditDimensions()` + `mergeLocalFindingsIntoAudits()` 处理，期望的输入格式是上述 `{ id, name, findings, level }` 结构。`findings` 数组的元素格式由 `normalizePreAuditDimensions()` 内部规范化，不要求 subagent 严格遵守特定字段名。

如果 subagent 执行失败，宿主应在聚合结果中标记该维度（具体方式由宿主决定，kevlar 侧通过 `parsed.dimensions` 中缺失该维度来感知失败）。

### 聚合逻辑

在 Phase D（Step 4 + Step 5），kevlar 代码执行聚合：

1. **收集所有 subagent 结果**：从宿主返回的文本中解析 6 个 JSON 结果
2. **错误处理**：如果某个维度 subagent 失败，记录 `partialFailures`，继续处理其他维度
3. **Delta 分析**（Step 4）：对比 bare text 和 full text 的 findings，标记上下文依赖风险
4. **合并**（Step 5）：将 code rule findings 和 subagent findings 合并，去重
5. **传递**：合并后的结果注入 Step 6（交叉验证）和 Step 8（最终仲裁）

### 聚合结果格式

聚合后的结果必须遵守 `LEGACY_RENDERING_SECTION` 的格式约束，确保最终报告格式一致。

### 并行确定性说明

Phase C 的"并行"取决于宿主 Task 工具的实现。如果宿主没有真正并行 spawn（而是串行），耗时仍为 O(6×T)。

**缓解措施**：在 dispatch prompt 中显式要求宿主并行执行，并在聚合时记录每个 subagent 的实际执行时间（如果宿主返回），方便后续验证和优化。

---

## 已有代码资产（可直接复用）

### `buildIsolatedSystemAuditorPrompt()` — `src/prompts/reviewWizard.ts:787`

已为 Sampling/Direct API 模式编写，可直接用作 Phase C 每个维度 subagent 的 system prompt：

```typescript
export function buildIsolatedSystemAuditorPrompt(
  auditor: Persona  // 注意：实际类型是 Persona，不是 SystemAuditor
): string
```

### `buildIsolatedSystemAuditorMessage()` — `src/prompts/reviewWizard.ts:813`

已为隔离模式编写，可直接用作每个维度 subagent 的 user message：

```typescript
export function buildIsolatedSystemAuditorMessage(
  content: string,
  auditor: Persona,  // 注意：实际类型是 Persona，不是 SystemAuditor
  options?: { 
    localFindings?: any[];
    step0Result?: Step0Result;
    timingContext?: string;
    webContext?: string;
  }
): string
```

### `clientInfo` — `src/execution/client.ts:24`

已记录宿主名称和版本，可直接用于宿主感知切换：

```typescript
export function setClientInfo(name: string, version?: string): void
```

---

## 不动的部分（硬约束）

以下代码和提示词 **本方案完全不修改**：

| 文件 | 内容 | 原因 |
|---|---|---|
| `src/prompts/reviewWizard.ts` | 6 个 `buildCompactAuditorCoT()` | 保留为 subagent 注入源 |
| `src/prompts/reviewWizard.ts` | `buildOrchestrationStep0Prompt()` | 保留为 fallback 的 Turn 1 |
| `src/prompts/reviewWizard.ts` | `buildOrchestrationAuditPrompt()` | 保留为 fallback 的 Turn 2 |
| `src/prompts/reviewWizard.ts` | `buildOrchestrationFinalizerPrompt()` | 保留为 fallback 的 Turn 3 |
| `src/prompts/reviewWizard.ts` | `buildCommonRiskRules()` | 保留 |
| `src/prompts/reviewWizard.ts` | `buildCoreReasoningFramework()` | 保留 |
| `src/prompts/reviewWizard.ts` | **`LEGACY_RENDERING_SECTION`** | **【硬性约束】输出格式协议不可改变** |
| `src/utils/stripContext.ts` | `stripContext()` | Step 1 代码步骤不变 |
| `src/execution/synergyCalculator.ts` | `calculateSynergy()` | Step 7 代码步骤不变 |
| `src/execution/dimensions.ts` | 6 个 system auditor 定义 | 不修改 |
| `src/tools/reviewContentWizardTool.ts` | 全部状态机和 handler | 仅新增调度分支，不删改现有逻辑 |
| `skills/auditors.json` | 系统审查员定义 | 不修改 |

### 输出格式约束（`LEGACY_RENDERING_SECTION`）

`src/prompts/reviewWizard.ts` 中的 `LEGACY_RENDERING_SECTION` 定义了 Pre-audit 结果的输出格式硬性约束，包括：

1. 风险等级标题格式（`[# 一级标题：风险等级]`）
2. 四个格式区块的顺序和约束
3. 排版协议

**本重构方案不修改此约束**。Subagent 模式下的每个维度审计结果，以及最终聚合报告，都必须遵守 `LEGACY_RENDERING_SECTION` 的格式要求。

---

## 实施计划

### 步骤 1：能力探测（`src/execution/client.ts`）

export function isSubagentDispatchSupported(): boolean {
  // 1. 环境变量强制开启（测试用）
  if (process.env.KEVLAR_ENABLE_SUBAGENT === "true") return true;

  // 2. 客户端信息不可用
  if (!clientInfo?.name) return false;

  // 3. 启发式检测已知支持 Task/subagent 的宿主
  const name = clientInfo.name.toLowerCase();
  if (name.includes("opencode")) return true;
  if (name.includes("claude-code") || name.includes("cline")) return true;
  if (name.includes("workbuddy") || name.includes("cursor")) return true;

  // TODO: 未来增加运行时检测（发送测试 prompt 验证宿主是否真的 spawn subagent）
  return false;
}
```

### 步骤 2：新增调度 prompt（`src/prompts/reviewWizard.ts`）

新增 `buildSubagentDispatchPrompt()`，与现有 `buildOrchestrationPrompt()` **并存**（fallback 不受影响）。

**Phase B subagent（Step 0b 联网搜索）prompt**：复用 `buildOrchestrationStep0Prompt()` 核心内容，改造为 subagent 调度指令（含联网搜索强制步骤 ④）。

**Phase C subagent（6 维度审计）prompt**：每个维度注入 `buildIsolatedSystemAuditorPrompt()`，作为独立 subagent 的 system prompt。

**Phase E subagent（Step 6 交叉验证）prompt**：复用 `buildOrchestrationFinalizerPrompt()` 中的互验逻辑。

**Phase G subagent（Step 8 最终仲裁）prompt**：复用 `buildOrchestrationFinalizerPrompt()` 中的仲裁逻辑。

### 步骤 3：模式注册（`src/execution/index.ts` + `src/execution/base.ts`）

```typescript
// base.ts — 新增模式定义
export type ExecutionMode = "orchestration" | "mcp_sampling" | "direct_api" | "mcp_subagent";
export type ResolveableMode = ExecutionMode | "auto";

// index.ts — 注册 handler，优先级 15（介于 sampling(10) 和 direct_api(20) 之间）
const handlers: ExecutionHandler[] = [
  orchestrationHandler,  // priority: 30 (fallback)
  samplingHandler,       // priority: 10 (preferred)
  subagentHandler,       // priority: 15 (new, between sampling and direct_api)
  directApiHandler,      // priority: 20 (medium)
];
```

### 步骤 4：初审接入（`src/tools/reviewContentWizardTool.ts`）

在 `executeLlmSystemAudit()` 中，解析 `step0Result` 之后、构建审计 prompt 之前，增加 subagent 调度分支：

```typescript
// executeLlmSystemAudit() 内部，Step 0b 结果解析完成后
const step0Result = state.step0Result;  // Step 0b 解析结果
const webContextMap = state.webContextMap;

// 新增：如果模式是 mcp_subagent 且宿主支持，进入 subagent 调度
if (mode === "mcp_subagent" && isSubagentDispatchSupported()) {
  // 构建 Phase C 调度 prompt，并行启动 6 个维度 subagent
  const dispatchPrompt = buildSubagentAuditDispatchPrompt({
    content: state.content,
    bareText: state.bareText,
    step0Result,
    webContextMap,
    auditors: loadAllAuditors(),  // 6 个系统审计员
  });
  state.step = "waitingForSubagentAudit";
  return toolResponse(state, dispatchPrompt);
}

// 现有：构建串行审计 prompt（orchestration / sampling / direct_api）
const auditPrompt = buildOrchestrationAuditPrompt(...);
```

**时机说明**：
- `handleOrchestrationStep0Result()`：处理 Step 0b 的原始返回，解析 `step0Result` + `webContextMap`
- `executeLlmSystemAudit()`：在解析完成后调用，此时已有 `step0Result` 和 `webContextMap`，可以注入 Phase C subagent prompt
- 把 subagent 调度放在这里，确保 Phase C 的 6 个维度 subagent 能拿到正确的上下文

**代码引用说明**：实施前需确认 `executeLlmSystemAudit()` 的实际位置和签名，以上为逻辑示意。

### 步骤 5：UI 暴露（`src/tools/getModesTool.ts`）

`get_execution_modes` 自动列出 `mcp_subagent`。

### 步骤 6：测试

| 场景 | 验证点 |
|---|---|
| 宿主支持 Task 时走 subagent 路径 | dispatch prompt 正确生成 |
| 宿主不支持时回退 orchestration | `isSubagentDispatchSupported() === false` 走原 3-turn |
| **预审计结果解析** | 能从 subagent 返回文本中正确解析 JSON 结果（实际实现使用 `JSON.parse(stripCodeFence(userMessage.trim()))`，见 `reviewContentWizardTool.ts:836`） |
| Phase C 6 维度并行输出格式 | 每维度产出独立 JSON，符合 `buildSubagentDispatchPrompt()` 中规定的格式 |
| 联网搜索保留 | Step 0b subagent prompt 包含 ④ 先例检索强制步骤 |
| Free 用户不受影响 | `state.tier === "free"` 直接 `rst_review`，不触发初审逻辑 |
| **聚合结果格式正确** | 最终报告遵守 `LEGACY_RENDERING_SECTION` 约束 |
| **部分 subagent 失败处理** | 记录 `partialFailures`，其他维度结果正常聚合 |
| **并行执行验证** | 宿主返回的执行时间显示 6 个 subagent 真正并行 |

### 步骤 7：文档更新

- `docs/README.zh.md` — 内容评审流程 mermaid 图增加 subagent 分支
- `AGENTS.md` — 执行模式表增加 `mcp_subagent`
- `docs/subagent-refactor.md` — 本文档（设计稿）

---

## 联网搜索保障

Step 0b 的联网搜索**不能丢失**。重构方案中：

- Step 0b subagent 的 system prompt **完整包含** `buildOrchestrationStep0Prompt()` 中步骤 ④ 的全部指令：
  - 先对每个 blackAtom 用 web search 搜索中文网络语境
  - 再执行先例检索（4.1 推断风险方向 → 4.2 用风险关键词搜索历史案例）
  - 返回 `precedents[1-3]` + `webContextMap`
- subagent 有完整的 opencode 工具权限（含 `webfetch`），可直接执行搜索
- `webContextMap` 和 `precedents` 照常注入 Phase C 的维度 subagent 和 Step 5 合并

**对比现状**：当前编排模式把联网搜索嵌在 Turn 1 的巨型 prompt 里让宿主手动搜，subagent 模式下 subagent 自己就能调用 webfetch，体验更好。

---

## 模式优先级与关系

自动模式（`auto`）下的解析顺序：

```
sampling (10) → mcp_subagent (15) → direct_api (20) → orchestration (30)
```

| 模式 | priority | 隔离性 | 成本 | 说明 |
|---|---|---|---|---|
| `mcp_sampling` | 10 | 最高 | 零（用宿主 token） | 依赖宿主支持 MCP sampling capability |
| `mcp_subagent` | 15 | 真隔离 | 零（用宿主 token） | 新增，依赖宿主支持 Task/subagent 调度 |
| `direct_api` | 20 | 高 | API key 成本 | 需要用户配置 `KEVLAR_API_KEY` |
| `orchestration` | 30 | 伪隔离 | 零 | 兜底，角色扮演式串行执行 |

**决策逻辑**：`mcp_subagent` 优先级介于 `mcp_sampling` 和 `direct_api` 之间。如果宿主支持 sampling，优先用 sampling（确定性最强）；如果不支持但支持 subagent，用 subagent（真隔离 + 零成本）；如果都不支持，用 direct_api 或 orchestration 兜底。

---

## 模式关系图（修正）

```
                    高隔离 │
                           │  ★ mcp_sampling      (10, 最高隔离 + 零成本)
                           │  ★ mcp_subagent       (15, 真隔离 + 零成本) ← 新增
                           │  ★ direct_api         (20, 高隔离 + API 成本)
                           │              ★ orchestration   (30, 伪隔离 + 零成本)
                    低隔离  │
                           └────────────────────────────────────────────→
                              高成本                          零成本
```

---

## 风险矩阵

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| 宿主不支持 Task 工具 | 🟡 中 | 保留 orchestration 做 fallback，宿主感知自动降级 |
| 未来宿主语义漂移 | 🟡 中 | prompt 头部显式说明 "使用 Task 工具"；可随宿主升级更新 |
| Phase G 聚合阶段二次污染 | 🟢 低 | 显式要求宿主只引用 findings_N 标签内容，不重新推理 |
| 无法控制 subagent 行为 | 🟢 低 | orchestration 本来也只关心最终文本，可接受 |
| 可观测性下降 | 🟢 低 | 通过 prompt 显式要求 subagent 输出 `<cot_N>` 保持可观察 |
| Free 用户误触发初审 | 🟢 低 | 已有 `state.tier !== "pro"` 守卫，不触动 |
| **Subagent 结果解析失败** | 🟡 中 | 要求 subagent 输出严格 JSON；解析失败时 fallback 到文本提取 |
| **Phase C 并行不确定性** | 🟡 中 | dispatch prompt 显式要求并行；记录执行时间；后续优化 |
| **输出格式约束违反** | 🔴 高 | **硬性要求** subagent 遵守 `LEGACY_RENDERING_SECTION`；在聚合时验证格式 |

---

## 未来优化

### 1. 运行时检测宿主 subagent 能力

当前 `isSubagentDispatchSupported()` 使用客户端名启发式判断，不够健壮。

**改进方向**：在 MCP 初始化阶段，发送一个测试 prompt，验证宿主是否真的会 spawn subagent。如果宿主无视指令，则降级到 orchestration 模式。

### 2. MCP 协议适配

当前方案用 prompt engineering 实现 subagent 调度，依赖宿主 AI 的遵从性。

如果未来 MCP 协议增加了标准的 subagent dispatch 能力（例如 server 可以调用 client 的 `tasks/spawn` API），本方案可以迁移到标准协议，获得更强的确定性。

**迁移路径**：保持 `mcp_subagent` 模式名称不变，将 `buildSubagentDispatchPrompt()` 的实现从 prompt engineering 改为调用标准 MCP API。

### 3. 可观测性增强

当前 subagent 模式的可观测性依赖 prompt 要求（输出 `<cot_N>`）。可以探索：
- 在 dispatch prompt 中要求 subagent 返回执行日志
- 在 kevlar 侧记录每个 subagent 的输入/输出/耗时
- 提供调试模式，展示完整的 subagent 调度过程

### 4. Phase C 并行度调优

当前 Phase C 固定启动 6 个 subagent。可以探索：
- 根据内容长度和风险等级动态调整并行数
- 对低优先级维度（如 `factual_integrity`）降低模型配置
- 支持用户配置哪些维度需要并行审计

---

## 文档与实际代码差异说明

本文档初版中存在以下与实际代码的差异，已在后续修订中修正。此处保留差异记录供参考。

| # | 问题 | 影响 | 修正状态 |
|---|---|---|---|
| 1 | 聚合 JSON schema 不一致（文档写 `auditorId`/`riskId`，实际是 `id`/`name`/`findings`/`level`） | 🔴 高 | ✅ 已修正（L163-188） |
| 2 | `buildIsolatedSystemAuditorMessage` options 签名错误（文档写 4 个参数，实际是 `localFindings`/`step0Result`/`timingContext`/`webContext`） | 🔴 高 | ✅ 已修正（L232-237） |
| 3 | `isSubagentDispatchSupported()` 客户端列表不完整（文档缺 `workbuddy`/`cursor`） | 🟡 中 | ✅ 已修正（L291-296） |
| 4 | `parseWizardResponse()` 引用不存在（实际用 `JSON.parse(stripCodeFence(...))`） | 🟡 中 | ✅ 已修正（L372） |
| 5 | `handleSubagentAuditResult()` 跳过 Step 4/6/8（当前只做 Step 5 + Step 7） | 🟡 中 | ✅ 已修正（Step 4/6/8 已补全，见 L830-989 及 commit `5f4e2bd`） |
| 5a | Phase E Step 6 交叉验证必须放在 `handleSubagentAuditResult()` 内部，不能跳过 | 🔴 高 | ✅ 已修正（见 `reviewContentWizardTool.ts:893-910`，无 caller 时使用宿主返回结果） |
| 5b | Phase G Step 8 最终仲裁必须放在 `handleSubagentAuditResult()` 内部，不能跳过 | 🔴 高 | ✅ 已修正（见 `reviewContentWizardTool.ts:920-964`，无 caller 时使用宿主返回结果） |
| 6 | `clientInfo` 行号偏差（文档写 `:27`，实际是 `:24`） | 🟢 低 | ✅ 已修正（L243） |
| 7 | `buildIsolatedSystemAuditorPrompt` 参数类型（文档写 `SystemAuditor`，实际是 `Persona`） | 🟢 低 | ✅ 已修正（L220） |
| 8 | `orchestration.ts` 文件引用错误（`buildSubagentDispatchPrompt` 实际在 `reviewWizard.ts`） | 🟢 低 | ✅ 已修正 |

---

## 相关文件索引

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/execution/base.ts` | 修改 | `ExecutionMode` 加 `"mcp_subagent"` |
| `src/execution/client.ts` | 修改 | 新增 `isSubagentDispatchSupported()` |
| `src/execution/index.ts` | 修改 | 注册 subagent handler，优先级 15 |
| `src/prompts/reviewWizard.ts` | 修改 | 新增 `buildSubagentDispatchPrompt()` |
| `src/execution/modes/subagent.ts` | **新增** | `subagentHandler` 执行器（standalone 路径） |
| `src/tools/reviewContentWizardTool.ts` | 修改 | 新增 subagent 调度分支 + `handleSubagentAuditResult()` |
| `src/tools/getModesTool.ts` | 修改 | UI 暴露 `mcp_subagent` 模式 |
| `src/prompts/reviewWizard.ts` | **不改** | 所有现有提示词函数不动 |
| `src/utils/stripContext.ts` | **不改** | Step 1 |
| `src/execution/synergyCalculator.ts` | **不改** | Step 7 |
| `src/execution/dimensions.ts` | **不改** | 6 个 auditor 定义 |
| `src/execution/strategy.ts` | **不改** | `FREE_PLAN` / `PRO_PLAN` |
| `skills/auditors.json` | **不改** | auditor 数据 |
| `docs/subagent-refactor.md` | 新增 | 本文档 |
