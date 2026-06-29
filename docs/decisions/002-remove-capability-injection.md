# 002 — 移除能力注入中间件，改用三层降级链（sampling → subagent → orchestration）

## 状态

提议中

## 背景

当前代码在 `src/index.ts` 中通过 `transport.onmessage` 预注册拦截 `initialize` 消息，用 `injectCapabilities()` 向客户端声明的 capabilities 中注入 `sampling`、`tasks.requests.sampling.createMessage`、`tasks.cancel`，受三个 `KEVLAR_ENABLE_*` 环境变量控制。

代码审计发现此方案存在 4 个问题：

### 问题 1：方案与实现不符

方案文档描述为"检查 clientInfo，按条件注入"，但实际代码是纯 env-var 驱动的无条件写入，完全不读 clientInfo，也不做任何客户端区分。

### 问题 2：Env var 含义扭曲

`mcpServers.<name>.env` 是 MCP 客户端提供给服务端的环境变量机制，本应用于 API Key、配置路径等参数。用它来做"替客户端撒谎"的开关，等于让用户在配置里手动声明握手能力——把 SDK 自动协商的责任推给了用户。

### 问题 3：违反 MCP Init 审计规范的 REQ-03

`docs/mcp-init-audit-requirements.md` 第 38 行明确规定：

> **【REQ-03】安全拦截机制（禁止直接覆写）**
> 服务端拦截握手参数时，禁止使用覆写或假定 SDK 内部链式调用 `transport.onmessage` 的方法。必须采用 Proxy 代理模式或自定义传输装饰器对底层 Transport 进行包裹，保障在 SDK 升级时拦截机制的向后兼容性。

当前代码直接覆写 `transport.onmessage` 并假设 `Protocol.connect()` 会链式调用此前存在的 handler——这是未写入 SDK 契约的实现细节，升级可能断裂。

### 问题 4：`tasks` 在顶级字段违反 REQ-04

`docs/mcp-init-audit-requirements.md` 第 45 行：

> **【REQ-04】标准顶级字段约束**
> Client 顶级能力：仅允许声明 `experimental`、`roots`、`sampling`。
> 扩展声明：任何非官方标准顶级定义的属性（如 `tasks`），必须移入 `experimental` 节点下。

当前 `injectCapabilities()` 将 `tasks.requests.sampling.createMessage` 写入 client caps 的顶级 `tasks` 下，服务端自身在 `server.ts` 也把 `tasks` 声明为顶级能力——双向违规。

## 验证结论

分别在 4 个客户端上测试 MCP 方法调用行为：

| 客户端 | `sampling/createMessage` | `sampling/createMessage` + task | `tasks/cancel` |
|--------|--------------------------|-------------------------------|----------------|
| quest-mcp-adaptor | `-32601` | `-32601` | `-32601` |
| WorkBuddy connector | `-32601` | `-32601` | `-32601` |
| opencode | `-32601` | `-32601` | `-32601` |
| OpenAI Codex | `-32601` | `-32601` | `-32601` |

关键发现：
- **MCP SDK 不拦截任何方法调用**——无论客户端是否声明了 `sampling` 或 `tasks`，请求始终透传至客户端
- 所有 4 个客户端均返回 `-32601 Method not found`——它们不实现这些标准方法
- 虚假声明的客户端能力声明（如 Codex 只有 `elicitation`）表明即使声称支持 sampling 的客户端也极少
- 这意味着 `injectCapabilities()` 和三个 `KEVLAR_ENABLE_*` 环境变量全是多余的

## 决策

### 核心架构：三层降级链

```
客户端声明了 sampling?
  │
  ├── 是 → L1: MCP sampling 协议（createMessage）
  │             ├── 成功 → 返回 LLM 结果
  │             └── 抛出 -32601 等 → 降级至 L2
  │
  └── 否 → L2: AgentBlueprint 子代理调度（mcp_subagent）
                ├── 宿主理解并执行 → 收 receipt，继续
                ├── 宿主回复 SEQUENTIAL_FALLBACK → 降级至 L3
                └── 宿主返回无效 receipt → 降级至 L3
                      │
                      └── L3: 宿主编排模式（orchestration）
                              └── 三回合角色扮演审计兜底
```

### L2：AgentBlueprint + 自然语言引导

当前 `mcp_subagent` 将纯 JSON 的 AgentBlueprint 作为 tool 输出返回给宿主。问题在于宿主 AI 对纯 JSON 的反应不可控——有的尝试执行，有的忽略，有的给出无意义响应。

改为自然语言引导包裹 JSON：

```
[Kevlar-4u] 子代理调度请求

我需要你对以下内容进行多维度审计。请为每个 agent 创建独立的子代理，
在隔离上下文中并行执行。

【如果你能执行子代理调度】
1. 读取下方 === AgentBlueprint === 中的 agent 定义
2. 为每个 agent 创建独立子代理执行 review
3. 汇总所有结果为一个完整的 ExecutionReceipt
4. 调用 review_content_wizard_continue 提交 receipt

【如果你不能执行子代理调度】
（例如当前环境不支持并行 / 不具备子代理工具）
→ 请直接回复 SEQUENTIAL_FALLBACK（仅这五个字，不要多余内容）
   我将自动切换到标准宿主编排模式继续审计。

=== AgentBlueprint ===
{ JSON }
```

关键设计点：

| 元素 | 作用 |
|------|------|
| 自然语言分步引导 | 所有 AI 客户端都能理解意图，不限中英文 |
| "能做 / 不能做" 明确分叉 | 消除中间状态——要么执行成功，要么触发降级 |
| `SEQUENTIAL_FALLBACK` 触发语 | 单一关键词，宿主回复即触发 `fallbackToStandardOrchestration()` |
| JSON 保留在代码块中 | 理解 JSON 的宿主可解析结构化定义，不理解的不影响降级决策 |

### L3：宿主编排（现有模式）

当 L2 无法工作时的三回合角色扮演审计。已有完整实现：

| 回合 | 内容 |
|------|------|
| Turn 1 | Step 0（规则引擎 + 全局解码 + 联网搜索） |
| Turn 2 | 6 维系统审计（顺序扮演 6 个审计员） |
| Turn 3 | 交叉验证 + 最终仲裁 |

### 改动一览

| # | 改动 | 文件 | 说明 |
|---|------|------|------|
| A | 删除 `injectCapabilities()` 函数 | `src/index.ts` | 移除能力伪造 |
| B | 删除 `dumpRawInit()` | `src/index.ts` | 不再 dump 篡改参数 |
| C | 注释掉 `transport.onmessage` 拦截逻辑，仅保留观测 | `src/index.ts` | 满足 REQ-03 |
| D | 删除 `KEVLAR_ENABLE_SAMPLING` 三个 env var 引用 | 全局 | 零配置目标 |
| E | 删除 `isSamplingSupported()` 中的 env override | `src/execution/client.ts` | |
| F | 删除 `resolveSamplingFn()` 中的 env 短路 | `src/execution/sampling.ts` | |
| G | 模式解析链改为：sampling → subagent → orchestration | `src/execution/index.ts` | 移除 observation cache 依赖 |
| H | `buildAgentBlueprint()` 返回内容包裹自然语言引导 + `SEQUENTIAL_FALLBACK` 指令 | `src/tools/reviewContentWizardTool.ts` | |
| I | `handleSubagentAuditResult()` 处理 `SEQUENTIAL_FALLBACK` 触发语 | `src/tools/reviewContentWizardTool.ts` | |
| J | 将 server.ts 中 `tasks` 声明移入 `experimental`（满足 REQ-04） | `src/server.ts` | 可选 |
| K | 更新 AGENTS.md 删除三个环境变量 | `AGENTS.md` | |

### 新工作流

```
Client 连接
  │
  ▼
initialize 透传（不篡改、不注入）
  │
  ▼
announceHandshakeToClient() 读取能力声明
  ├── 记录真实 capabilities（仅供调试）
  └── 写入 client.ts 能力缓存
  │
  ▼
用户调用 review_content_wizard
  │
  ├── 需要 sampling 且客户端声明了 sampling?
  │     ├── 是 → 调用 createMessage
  │     │           ├── 成功 → 返回结果
  │     │           └── -32601 → 降级 L2
  │     └── 否 → 投递 AgentBlueprint
  │               ├── 宿主提交 receipt → 完成
  │               ├── SEQUENTIAL_FALLBACK → 降级 L3
  │               └── 无效 receipt → 降级 L3
  │
  └── L3: 宿主编排（标准三回合审计）
```

## 对用户的影响

| 变化 | 用户需要做什么 |
|------|---------------|
| 删除 `KEVLAR_ENABLE_SAMPLING` | 从 MCP 客户端配置中移除 |
| 删除 `KEVLAR_ENABLE_TASK_AUGMENTED` | 同上 |
| 删除 `KEVLAR_ENABLE_TASK_CANCEL` | 同上 |

用户配置从：

```json
{
  "env": {
    "KEVLAR_ENABLE_SAMPLING": "true",
    "KEVLAR_ENABLE_TASK_AUGMENTED": "true"
  }
}
```

变成：

```json
{
  "env": {
    "KEVLAR_API_KEY": "sk-..."
  }
}
```

## 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| 宿主不理解蓝图也不回 SEQUENTIAL_FALLBACK，给出无关响应 | 中 | validateReceipt() 失败即可触发 fallback |
| 宿主声称执行了子代理但返回空结果 | 低 | validateReceipt() 检查 agent 数量一致、findings 非空 |
| sampling 首次调用成功但后续失败 | 低 | 每次独立 try/catch，单次失败不影响后续 |
| 耗时增加（L2→L3 多一次回退） | 中 | SEQUENTIAL_FALLBACK 一路回退到 L3 只需一次额外工具调用 |

## 否决的方案

### 方案 A：保留注入 + 握手期异步探测 + 每日缓存

原架构提案。否决原因：验证证明 SDK 不拦截 `createMessage`，注入和探测都是多余的。三层降级链更简洁，零配置。

### 方案 B：保留 env var 但不注入，仅作为 `isSamplingSupported()` 的 override

即删除注入，但保留 `KEVLAR_ENABLE_SAMPLING` 让用户手动声明。
否决原因：用户不需要手动声明——降级链自动处理所有情况。保留 env var 仍然意味着"配置里写开关"，违背了"零配置"目标。

## 相关文档

- `docs/mcp-init-audit-requirements.md` — REQ-03、REQ-04
- `docs/client-capability-detection.md` — 需同步更新
- `docs/audit-hybrid-execution.md` — 需同步更新
- `docs/decisions/001-multi-file-persona-storage.md` — 之前的决策记录
- `AGENTS.md` — 需删除三个 `KEVLAR_ENABLE_*` 的文档行
