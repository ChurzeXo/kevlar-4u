# mcp_subagent 模式：宿主 AI 仅创建 2 个 subagent 问题分析报告

> 日期：2025-07-16  
> 问题：在 Kevlar Pro 模式 mcp_subagent 执行下，宿主 AI 只创建了 `legal_compliance` 和 `cross_lingual_distortion` 2 个 subagent，而非预期的 6 个。

---

## 1. AgentBlueprint 完整结构

`AgentBlueprint` 定义在 `src/execution/protocol.ts:15-31`：

```typescript
interface AgentBlueprint {
  protocol: "kevlar.exec/v1";

  execution: {
    mode: "ephemeral_agents";
    allowedModes: ("native_subagent" | "simulated_agent")[];
    concurrency: number;           // ← 应为 6
    isolation: {
      required: boolean;            // ← true
      level: "strict" | "best_effort";  // ← "strict"
    };
  };

  agents: AgentDefinition[];       // ← 应有 6 个 entry
  aggregation: AggregationSpec;    // ← requireAllAgents: true
  continuation: ContinuationSpec;
}

interface AgentDefinition {
  id: string;           // e.g. "legal_compliance"
  role: string;         // "safety_reviewer" | "policy_reviewer" | "context_reviewer"
  instructions: string; // 完整的独立审计指令（含身份、框架、内容、协议）
  input: { contentRef: string };
  outputSchema: "kevlar.reviewer/v1";
}

interface AggregationSpec {
  strategy: "host_merge";
  rules: {
    requireAllAgents: boolean;     // ← true = 必须全部 6 个
    conflictResolution: "risk_maximization";
    outputSchema: "kevlar.audit/v1";
  };
}
```

**6 个 AgentDefinition 的 ID 和角色映射**（来自 `skills/auditors.json` + `buildAgentBlueprint()`）：

| # | ID | Name | Role |
|---|-----|------|------|
| 1 | `legal_compliance` | 合规哨兵 | `policy_reviewer` |
| 2 | `context_distortion` | 语境猎手 | `context_reviewer` |
| 3 | `network_culture_risk` | 暗语破译 | `safety_reviewer` |
| 4 | `factual_integrity` | 事实判官 | `safety_reviewer` |
| 5 | `social_risk` | 社伦判官 | `safety_reviewer` |
| 6 | `cross_lingual_distortion` | 跨界判官 | `safety_reviewer` |

---

## 2. Blueprint 生成流程 (Step 3 — systemAudit)

### 触发条件

在 `handleSystemAudit()` (`src/tools/reviewContentWizardTool.ts:574-769`)：

```typescript
// line 646-657
const plan = state.executionPlan;
if (plan?.backend === "host_orchestration" && plan.strategy === "structured") {
  // ... 进入 mcp_subagent 路径
  const prompts = await resolvePromptSegments();
  const blueprint = buildAgentBlueprint(state, systemAuditors, prompts);
  (state as any).blueprint = blueprint;
  // ...
}
```

路径条件：
- `state.tier === "pro"` → 进入 Pro 路径
- `plan.backend === "host_orchestration"` + `plan.strategy === "structured"`
  - 由 `resolveExecutionPlan()` 中的 L3/L4 分支决定（`src/execution/index.ts:235-265`）
  - 当 `getHostStructuredObservation()` 返回非 unsupported/failed 时，使用 `structured` 策略
  - `legacyMode` 被设为 `"mcp_subagent"`

### buildAgentBlueprint 核心逻辑

```typescript
// line 784-860
function buildAgentBlueprint(state, systemAuditors, prompts) {
  const agents: AgentDefinition[] = systemAuditors.map((auditor) => ({
    id: auditor.meta.id,
    role: /* policy_reviewer/context_reviewer/safety_reviewer */,
    instructions: buildIsolatedAgentInstructions(auditor, ...),  // 自包含
    input: { contentRef: "content" },
    outputSchema: "kevlar.reviewer/v1",
  }));

  // §2.1: 警告守卫 — agents 数量不等于 6
  if (agents.length !== 6) {
    logger.warn("AgentBlueprint agent count mismatch", {
      event: "agent_count_mismatch",
      expected: 6, actual: agents.length, agentIds: agents.map(a => a.id),
    });
  }

  return {
    protocol: "kevlar.exec/v1",
    execution: {
      mode: "ephemeral_agents",
      allowedModes: ["native_subagent", "simulated_agent"],
      concurrency: systemAuditors.length,  // 通常为 6
      isolation: { required: true, level: "strict" },
    },
    agents,
    aggregation: {
      strategy: "host_merge",
      rules: {
        requireAllAgents: true,          // ← 明确要求全部 6 个
        conflictResolution: "risk_maximization",
        outputSchema: "kevlar.audit/v1",
      },
    },
    continuation: { /* ... */ },
  };
}
```

每个 agent 的 `instructions` 由 `buildIsolatedAgentInstructions()` 生成，包含：
1. Auditor 身份声明
2. Pro 增强核心推理框架
3. 冷读协议步骤
4. Auditor 专属 systemPrompt
5. 待审核内容（原文 + 裸文）
6. 本地规则引擎发现
7. 审计执行协议（Step 1→2→3）

---

## 3. 发给宿主 AI 的 Dispatch Prompt 分析

### 完整 Prompt 结构

`handleSystemAudit()` 中构建的 `blueprintText`（line 676-752）：

```
┌─────────────────────────────────────────────┐
│ ## Kevlar-4u Subagent Dispatch Request       │  ← 标题
│                                              │
│ I need you to audit the following content    │  ← 弱指令（~3 句）
│ across multiple dimensions.                  │
│ Create independent subagents for each agent, │
│ executing in parallel with isolated context. │
│                                              │
│ ### If you can execute subagent dispatch     │  ← 执行步骤（4 条）
│ 1. Read each agent definition...             │
│ 2. Create a subagent for each agent...       │
│ 3. Aggregate all results...                  │
│ 4. Call review_content_wizard_continue...    │
│                                              │
│ ### ExecutionReceipt Structure               │  ← 巨型 JSON schema 模板
│ { "protocol": "kevlar.exec/v1", ... }        │    (~30 行)
│                                              │
│ ### Pro option: submit per-agent results     │  ← 仅 Pro tier
│ ...                                          │
│                                              │
│ ### If you CANNOT execute subagent dispatch  │  ← 降级路径
│ → Call review_content_wizard with            │
│   SEQUENTIAL_FALLBACK                        │
│                                              │
│ ---                                          │
│ ### AgentBlueprint                           │  ← JSON 数据块
│ ```json                                      │
│ { protocol, execution, agents: [...6],       │
│   aggregation: { requireAllAgents: true } }  │
│ ```                                          │
└─────────────────────────────────────────────┘
```

### Prompt 措辞分析 — 是否足够强制？

| 指标 | 当前措辞 | 评估 |
|------|----------|------|
| 是否明确说"6 个" | ❌ 未提及 | **严重问题** |
| 是否逐一列出 6 个 agent 名称 | ❌ 未列出 | **严重问题** |
| 是否说明不可跳过 | ❌ 未说明 | **严重问题** |
| 创建指令 | "Create independent subagents for each agent" | 模糊（"each agent" 依赖宿主理解 JSON） |
| 强制执行标记 | 仅在 JSON 中 (`requireAllAgents: true`) | JSON 不保证被解析 |
| 降级路径 | 允许 `SEQUENTIAL_FALLBACK` | 正确但宿主可能不知道需要触发 |
| 后果警告 | ❌ 无 | 未说明少于 6 个会怎样 |

**核心问题**：整个 prompt 中，"6" 这个数字只出现在 AgentBlueprint JSON 内部的 `agents` 数组长度和 `concurrency` 字段中。人类可读的指令部分没有一处提到"必须创建 6 个 subagent"或逐一列举 6 个维度的名称。

---

## 4. 宿主 AI 收到 Blueprint 后的预期行为

### 设计预期

按设计文档 `docs/subagent-refactor.md`，宿主 AI 应该：

1. 解析 AgentBlueprint JSON
2. 遍历 `agents` 数组（6 个 entry）
3. 为每个 entry 并行创建一个 subagent，注入对应的 `instructions`
4. 等待所有 subagent 完成
5. 将结果聚合为 ExecutionReceipt 格式
6. 调用 `review_content_wizard_continue` 提交

### 实际可能的宿主行为

宿主 AI 拿到这段 prompt 后：

- **现象 A（仅创建 2 个）**：宿主 AI 粗略扫描 prompt 后，自行判断"最有代表性的 2 个维度"或"第一个和最后一个"，跳过中间 4 个。这可能是 LLM 的"取首尾"启发式行为。
- **现象 B（串行执行）**：宿主不理解"并行 subagent"概念，在单个 context window 内串行处理。
- **现象 C（完全忽略）**：宿主直接降级到 `SEQUENTIAL_FALLBACK`。

### 为什么是 legal_compliance 和 cross_lingual_distortion？

这两个是 auditors.json 中的 **第一个** 和 **最后一个**。这是 LLM 常见的"取边界"行为模式——当指令模糊时，模型倾向于选取列表的首尾元素作为"代表"。

---

## 5. 根因分析

### 根本原因（按影响从高到低）

#### 🔴 P0：Dispatch Prompt 缺乏强制约束

在 `handleSystemAudit()` 第 676-752 行构建的 `blueprintText` 中：

```text
"Create independent subagents for each agent, executing in parallel"
```

这句话是 prompt 中对宿主 AI 的唯一行为指令。它：
- 没说有 6 个 agent
- 没说必须全部创建
- 没说遗漏任何一个会导致验证失败
- 没说哪些 agent 是必须的

`requireAllAgents: true` 和 `concurrency: 6` 这两个关键约束仅存在于 JSON 数据块中，而 JSON 块在 prompt 中作为 markdown code block 呈现。宿主 AI 可能：
- 不解析 JSON，只读自然语言指令
- 部分解析 JSON，但忽略嵌套的 `rules` 下的 `requireAllAgents`
- Token 限制导致截断，看不到 JSON 部分

#### 🟡 P1：AgentBlueprint JSON 与人类指令脱节

prompt 的结构是：
1. 先说人话指令（模糊）
2. 再给 ExecutionReceipt 模板（长）
3. 再给 Pro 选项
4. 最后把 AgentBlueprint JSON 贴在 `---` 分隔线下面

这违反了"关键约束前置"的原则。宿主 AI 可能在处理前面的自然语言后就开始行动，甚至在读到 JSON 之前就已经决定了 subagent 策略。

#### 🟡 P2：没有 agent 名称的明文枚举

prompt 中从未出现：
```
You MUST create ALL 6 of the following subagents:
1. legal_compliance (合规哨兵)
2. social_risk (社伦判官)
3. context_distortion (语境猎手)
4. network_culture_risk (暗语破译)
5. factual_integrity (事实判官)
6. cross_lingual_distortion (跨界判官)
```

6 个 agent 的名称和 ID 只存在于 AgentBlueprint JSON 中。宿主 AI 如果不仔细解析 JSON，就无法知道有哪些 agent。

#### 🟡 P3：Pro per-agent 选项可能产生歧义

```text
"### Pro option: submit per-agent results individually"
"If your environment can submit results as each agent completes:"
```

这段文本可能让宿主产生"可以分批提交"的理解，甚至错误地认为"可以先提交 2 个，再提交剩下的"——但实际上它提示的是另一种提交方式（逐个 slot 提交），而不是允许只创建部分 agent。

#### 🟢 P4：验证机制是事后的

`validateReceipt()` → `runAggregationValidation()` 在宿主提交 receipt 后才会触发，此时：
- `allAgentsPresent: false` 导致 `status: "invalid"`
- 触发 `fallbackToStandardOrchestration()` 降级到 3-turn 编排模式
- 但宿主已经浪费了一轮 MCP 往返，用户体验受损

虽然降级机制正确工作，但它是一个**错误恢复**而非**错误预防**机制。

---

## 6. 改进建议

### 建议 1（🔴 紧急）：强化 Dispatch Prompt 的强制约束

在 `handleSystemAudit()` 的 `blueprintText` 开头增加显式的强制声明：

```typescript
const blueprintText = [
  "## Kevlar-4u Subagent Dispatch Request",
  "",
  // ── 新增：显式强制约束 ─────────────────────────────────
  "### ⚠️ CRITICAL: You MUST create ALL of the following subagents",
  "",
  "This is a NON-NEGOTIABLE requirement. You must create exactly one subagent",
  "for EACH of the 6 system auditors listed below. Skipping any auditor will",
  "cause the submission to be REJECTED by the validation gate.",
  "",
  "The REQUIRED auditors are:",
  systemAuditors.map((a, i) =>
    `  ${i + 1}. **${a.meta.id}** — ${a.meta.name}（${a.meta.description?.slice(0, 40) ?? ""}）`,
  ).join("\n"),
  "",
  `Total: ${systemAuditors.length} subagents MUST be created and executed.`,
  "",
  "---",
  // ── 原内容继续 ─────────────────────────────────────────
  "I need you to audit the following content across multiple dimensions.",
  // ...
].join("\n");
```

### 建议 2（🟡 推荐）：将 AgentBlueprint 提前且不藏在 Code Block 中

将 AgentBlueprint 的关键字段以自然语言形式前置：

```typescript
const requiredAgentsText = systemAuditors.map((a, i) =>
  `| ${i + 1} | \`${a.meta.id}\` | ${a.meta.name} | ${a.meta.sandbox?.responsibility ?? ""} |`
).join("\n");

const blueprintText = [
  "## Kevlar-4u Subagent Dispatch Request",
  "",
  "### Required Agents (ALL 6 must be created)",
  "",
  "| # | Agent ID | Name | Responsibility |",
  "| --- | --- | --- | --- |",
  requiredAgentsText,
  "",
  `**Requirement**: Create ${systemAuditors.length} independent subagents.`,
  `**Validation**: Fewer than ${systemAuditors.length} agents → REJECTED.`,
  // ...
].join("\n");
```

### 建议 3（🟡 推荐）：增加"不完整"后果的明确警告

```text
"⚠️ CONSEQUENCE OF INCOMPLETE EXECUTION:",
"If you submit a receipt with fewer than 6 agents, the validation will FAIL",
"and Kevlar will force a fallback to the slower 3-turn orchestration mode.",
"This wastes a full MCP round-trip and degrades the user experience.",
"",
"Make sure ALL 6 agents are created and executed before submitting."
```

### 建议 4（🟢 可选）：统计并记录实际 subagent 数量

在 `buildAgentBlueprint` 之后，增加一个 stderr 日志：

```typescript
writeRawStderr(
  `[Kevlar-4u] 📋 AgentBlueprint dispatched: ${blueprint.agents.length} agents ` +
  `(${blueprint.agents.map(a => a.id).join(", ")}) | ` +
  `requireAllAgents: ${blueprint.aggregation.rules.requireAllAgents}`,
);
```

这样在调试时可以立即看到 Kevlar 发出了几个 agent 的蓝图。

### 建议 5（🟢 可选）：Bloom filter / 轻量级 host capability check

在 `handleSystemAudit` 发送 blueprint 之前，先做一个轻量级检测——让宿主返回它理解到的 agent 数量：

```text
"Before creating subagents, confirm: How many agents do you see in this blueprint?",
"Reply with just the number, then proceed to create subagents."
```

但这会增加额外的 MCP 往返，仅适合在调试/探测模式下使用。

### 建议 6（🟢 长期）：MCP 协议级别的 subagent dispatch

当前方案完全依赖 prompt engineering。理想情况下，如果 MCP 协议未来支持 server-to-client 的 task dispatch，Kevlar 可以直接通过协议层调用宿主的 subagent API，彻底消除 prompt 解析的不确定性。

---

## 7. 总结

| 维度 | 状态 | 说明 |
|------|------|------|
| AgentBlueprint 数据结构 | ✅ 正确 | `agents: [6]`, `concurrency: 6`, `requireAllAgents: true` |
| buildAgentBlueprint 构建逻辑 | ✅ 正确 | 正确遍历 6 个 systemAuditors |
| Dispatch Prompt 强制约束 | 🔴 不足 | 没有显式说"必须 6 个"，没有枚举 agent 名称 |
| 降级兜底机制 | ✅ 正确 | `validateReceipt` → `fallbackToStandardOrchestration` |
| 事后验证 | ✅ 正确 | `allAgentsPresent` 检查在提交时生效 |

**核心结论**：问题不在 AgentBlueprint 的数据结构或构建逻辑，而在于发送给宿主 AI 的 **Dispatch Prompt 措辞不够强制**。人类可读指令没有明确要求"必须创建 6 个 subagent"，也没有逐一列举 6 个维度名称。宿主 AI 在模糊指令下做出了"选取首尾两个代表性 agent"的启发式判断。

**最快修复**：在 `blueprintText` 开头增加显式的强制声明，列出全部 6 个必须创建的 agent 名称，并说明遗漏会导致验证失败。
