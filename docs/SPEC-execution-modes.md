# Kevlar 多执行模式需求文档

> **文档版本**：2.0.0
> **更新日期**：2026-05-18
> **状态**：定稿

---

## 一、背景与目标

### 1.1 项目定位

Kevlar 是一个基于 MCP（Model Context Protocol）规范的内容压力测试工具，通过多角色协同评审帮助创作者在内容发布前发现潜在问题。

### 1.2 设计目标

本次更新引入**三种执行模式**，让用户根据场景选择：

| 模式 | 标识符 | 目标用户 |
|------|--------|----------|
| **编排代理模式**（默认） | `orchestration` | 追求简单开箱即用 |
| **MCP Sampling 模式** | `mcp_sampling` | 需要深度并行分析 |
| **Direct API 模式** | `direct_api` | 无 MCP 客户端环境 |

**优先级降级链**（`auto` 模式时）：
```
用户选 auto
  → 检查: kevlar-config.json 有持久化配置？  是 → 使用配置中的模式
  → 检查: 宿主客户端支持 MCP Sampling?      是 → 用 mcp_sampling
  → 检查: 是否配置了 API Key?               是 → 用 direct_api
  → 兜底:                                     → 用 orchestration
```

---

## 二、执行模式详解

### 2.1 Orchestration 模式（默认）

#### 原理
Kevlar Server 将所有 Persona 指令聚合到**单次 Prompt** 中，一次性发送给宿主 AI Client 执行。**当前 Kevlar 的唯一模式，零 Token 成本。**

#### 执行流程
```
用户调用 review_content(mode="orchestration")
    ↓
Kevlar 构建包含 N 个 Persona 指令的编排 Prompt
    ↓
单次 MCP 调用 → 宿主 AI Client
    ↓
宿主返回聚合结果
```

#### 优点
- 简单可靠，零额外配置
- 零 Token 成本（Kevlar 本身不调用任何模型）
- 无速率限制风险
- Persona 数量理论上无上限

#### 缺点
- 非真正并行，执行速度 = 最慢 Persona 的耗时
- Prompt 长度随 Persona 数量线性增长
- 人格隔离依赖宿主模型能力

---

### 2.2 MCP Sampling 模式

#### 原理
Kevlar 为每个 Persona 发起独立的 MCP `sampling/createMessage` 调用，实现真正的并行多智能体执行。

#### 客户端检测
MCP 握手阶段通过 `initialize` 请求的 `clientInfo.name` 判断：

```typescript
// src/execution/client.ts
const SAMPLING_CLIENTS = new Set([
  "claude-ai",
  // 以下需实测确认后添加：
  // "Cursor",
]);

export function isSamplingSupported(clientName: string): boolean {
  return SAMPLING_CLIENTS.has(clientName);
}
```

不在名单内的客户端 `mcp_sampling` 模式标记为不可用，但用户仍可选择——Kevlar 会尝试调用并在失败时给出明确降级提示。

#### 执行流程
```
用户调用 review_content(mode="mcp_sampling")
    ↓
Kevlar 为每个 Persona 构建独立 Sampling 请求
    ↓
限流执行器（Semaphore + 退避重试）
    ↓
并行发送 sampling/createMessage
    ↓
收集结果 → 聚合 → 返回报告
```

#### 优点
- 真正并行，执行速度 ≈ 最快 Persona 的耗时
- 每个 Persona 完全独立，人格零串味
- 无 Prompt 长度瓶颈

#### 缺点
- Token 成本 = 编排模式的 N 倍
- 受限于宿主 Sampling 速率限制
- 需要客户端支持 Sampling 能力

---

### 2.3 Direct API 模式

#### 原理
Kevlar 直接调用第三方 LLM API（OpenAI / Anthropic / Ollama 等兼容 endpoint）。

#### 执行流程
```
用户调用 review_content(mode="direct_api")
    ↓
Kevlar 验证 API Key（仅从环境变量读取）
    ↓
估算 Token 成本 → 检查是否超预算
    ↓
限流执行器 → 并行调用 LLM API
    ↓
收集结果 → 聚合 → 返回报告
```

#### 优点
- 无需 MCP 客户端
- 完全可控的模型选择（支持 OpenAI / Anthropic / Ollama 等）
- 支持离线/无网络受限环境

#### 缺点
- 需要配置 API Key（仅通过环境变量）
- Token 成本完全由用户承担
- API Key 泄露风险需防范

---

## 三、架构设计

### 3.1 目录结构

```
src/
├── execution/                        # 执行层（新增）
│   ├── index.ts                      # 统一入口 + 模式注册
│   ├── base.ts                       # 接口定义 + 类型
│   ├── client.ts                     # 客户端能力检测
│   ├── limiter.ts                    # 限流器（Semaphore + 退避）
│   ├── aggregator.ts                 # 结果聚合器
│   ├── config.ts                     # kevlar-config.json 读写
│   └── modes/
│       ├── orchestration.ts          # 编排模式
│       ├── sampling.ts               # MCP Sampling 模式
│       └── direct_api.ts             # Direct API 模式
├── tools/
│   ├── reviewTool.ts                 # 简化为入口 + 参数校验
│   └── getModesTool.ts               # 新增：查询可用模式
└── utils/
    ├── types.ts                      # 共享类型
    ├── parser.ts                     # Persona 文件解析
    └── errors.ts                     # 错误码 + 错误处理
```

### 3.2 核心接口

```typescript
// src/execution/base.ts

export type ExecutionMode = "orchestration" | "mcp_sampling" | "direct_api";

export interface ExecutionContext {
  skillsDir: string;
  personas: Persona[];
  content: string;
  context?: string;
}

export interface ExecutionResult {
  report: string;
  personas: string[];       // 参与评审的 Persona ID
  mode: ExecutionMode;
  partialFailures?: Array<{ personaId: string; error: string }>;
}

export interface ExecutionHandler {
  mode: ExecutionMode;
  /** 检查当前环境是否支持此模式 */
  canExecute(): boolean;
  /** 执行评审 */
  execute(ctx: ExecutionContext): Promise<ExecutionResult>;
  /** 默认优先级（数字越小优先级越高） */
  priority: number;
}
```

### 3.3 模式注册与分发

```typescript
// src/execution/index.ts

const handlers: ExecutionHandler[] = [
  orchestrationHandler,   // priority: 10（兜底）
  samplingHandler,        // priority: 20
  directApiHandler,       // priority: 30
];

export async function executeReview(
  mode: ExecutionMode | "auto",
  ctx: ExecutionContext
): Promise<ExecutionResult> {
  const resolved = mode === "auto"
    ? await resolveMode()
    : mode;

  const handler = handlers.find((h) => h.mode === resolved);
  if (!handler) throw new Error(`未知模式: ${resolved}`);
  if (!handler.canExecute()) throw new Error(`${resolved} 不可用`);

  return handler.execute(ctx);
}

async function resolveMode(): Promise<ExecutionMode> {
  // 1. 检查持久化配置
  const config = readConfig();
  if (config.mode && config.mode !== "auto") return config.mode;

  // 2. 按优先级选择第一个可用的
  const sorted = [...handlers].sort((a, b) => a.priority - b.priority);
  for (const h of sorted) {
    if (h.canExecute()) return h.mode;
  }

  return "orchestration"; // 永远可用
}
```

### 3.4 用户配置持久化（`skills/kevlar-config.json`）

配置文件用于存储非敏感的偏好设置，API Key **绝不**写入此文件。

```json
{
  "mode": "auto",
  "multiAgent": {
    "maxConcurrency": 3,
    "timeoutMs": 60000
  },
  "personaOrder": [],
  "createdAt": "2026-05-18T00:00:00Z",
  "updatedAt": "2026-05-18T00:00:00Z"
}
```

- 路径：`skills/kevlar-config.json`（复用已有的 path validation）
- `.gitignore` 中添加此文件（因人设排序等属于个人偏好）
- 不存在时使用全部默认值，不报错

---

## 四、限流与错误处理

### 4.1 限流架构

复用单一的 `RateLimiter` 类，`mcp_sampling` 和 `direct_api` 模式共享：

```typescript
// src/execution/limiter.ts

interface RateLimitConfig {
  maxConcurrent: number;     // 最大并发数
  minDelayMs: number;        // 最小请求间隔
}

class RateLimiter {
  private semaphore: Semaphore;
  private lastExecution = 0;

  constructor(config: RateLimitConfig) {
    this.semaphore = new Semaphore(config.maxConcurrent);
  }

  async acquire(): Promise<void> { /* 信号量获取 */ }
  release(): void { /* 信号量释放 */ }
}
```

环境变量覆盖默认值：
```bash
KEVLAR_MAX_CONCURRENT=3
KEVLAR_MIN_DELAY_MS=1000
```

### 4.2 Token 预算控制

所有涉及模型调用的模式（`mcp_sampling`、`direct_api`）在执行前进行预算检查：

```typescript
// 强制预算检查（执行前阻断）
const DEFAULT_BUDGET = {
  per_task: 50_000,
  per_persona: 10_000,
};

function estimateTokenCost(personas: number, contentLength: number): number {
  return (contentLength / 4) + personas * DEFAULT_BUDGET.per_persona;
}

function checkBudget(personas: number, contentLength: number): void {
  const budget = Number(process.env.KEVLAR_TOKEN_BUDGET_PER_TASK) || DEFAULT_BUDGET.per_task;
  const estimated = estimateTokenCost(personas, contentLength);
  if (estimated > budget) {
    throw new Error(
      `预估 Token 消耗 (${estimated}) 超出预算 (${budget})。` +
      `请减少评论员数量或缩短内容长度。`
    );
  }
}
```

### 4.3 重试与部分失败

```typescript
// 重试策略：指数退避
interface RetryConfig {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  backoffMs: 1000,
  backoffMultiplier: 2,
};

// 部分失败不中断整体流程
interface PartialResult<T> {
  successful: T[];
  failed: Array<{ index: number; error: string }>;
  successRate: number;
}
```

- 可重试的错误类型：`rate_limit_exceeded`、`service_unavailable`、`timeout`
- 非可重试错误（如 `invalid_api_key`）：立即失败，不重试
- Persona 级别的失败不影响其他 Persona 的结果
- 最终报告中标注失败的人设及其错误原因

---

## 五、API Key 安全管理

### 5.1 读取规则

```
优先级：KEVLAR_API_KEY > ANTHROPIC_API_KEY > OPENAI_API_KEY
来源：仅环境变量（禁止通过工具参数传入）
```

### 5.2 格式校验

```typescript
const PROVIDERS = {
  anthropic: /^sk-ant-.*$/,
  openai:    /^sk-.*$/,
  // 其他可扩展
};

function validateApiKey(key: string): { valid: boolean; provider?: string } {
  for (const [name, pattern] of Object.entries(PROVIDERS)) {
    if (pattern.test(key)) return { valid: true, provider: name };
  }
  return { valid: false };
}
```

### 5.3 日志脱敏

```typescript
function maskKey(key: string, visible = 4): string {
  if (key.length <= visible * 2) return "*".repeat(key.length);
  return key.slice(0, visible) + "*".repeat(8) + key.slice(-visible);
}
// 示例：sk-ant-****abcd
```

### 5.4 `.gitignore` 保护

```
.env
.env.local
.env.*.local
skills/kevlar-config.json
```

---

## 六、工具接口设计

### 6.1 review_content（重构）

```typescript
export const reviewToolDefinition: Tool = {
  name: "review_content",
  description: "将文案交给多个评论员进行压力测试。支持三种执行模式。",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string" },
      persona_ids: { type: "array", items: { type: "string" } },
      context: { type: "string" },
      mode: {
        type: "string",
        enum: ["auto", "orchestration", "mcp_sampling", "direct_api"],
        default: "auto",
      },
    },
    required: ["content"],
  },
};
```

**`auto` 行为**：
1. 查询 `kevlar-config.json` 中持久化的 mode
2. 若未配置，按优先级选第一个可用的
3. 返回报告时附加一行 `*执行模式：{mode}*`

### 6.2 get_execution_modes（新增）

```typescript
export const getModesToolDefinition: Tool = {
  name: "get_execution_modes",
  description: "查询当前可用的执行模式及配置状态。",
  inputSchema: { type: "object", properties: {} },
};
```

返回示例：
```
**可用执行模式**

| 模式 | 状态 | 说明 |
|------|------|------|
| 编排代理模式 | ✅ 可用 | 单次 Prompt 调用，简单可靠 |
| MCP 采样模式 | ✅ 可用 | 真正并行执行，深度分析 |
| 直接 API 模式 | ❌ 未配置 API Key | 需设置 KEVLAR_API_KEY |

**推荐模式**：mcp_sampling
**当前配置**：auto → mcp_sampling
```

---

## 七、环境变量清单

```bash
# ── 执行模式 ──────────────────────────────────────
# auto（默认）| orchestration | mcp_sampling | direct_api
KEVLAR_MODE=auto

# ── Direct API 模式 ────────────────────────────────
KEVLAR_API_KEY=           # 优先级最高
ANTHROPIC_API_KEY=        # 次选
OPENAI_API_KEY=           # 末选

# ── Token 预算 ────────────────────────────────────
KEVLAR_TOKEN_BUDGET_PER_TASK=50000   # 单次任务上限

# ── 速率限制 ──────────────────────────────────────
KEVLAR_MAX_CONCURRENT=3              # mcp_sampling / direct_api
KEVLAR_MIN_DELAY_MS=1000            # 请求间隔

# ── 日志 ───────────────────────────────────────────
LOG_LEVEL=info
```

---

## 八、实现路线图

| Phase | 内容 | 预估代码量 |
|-------|------|-----------|
| **P1** | 创建 `src/execution/` 目录 + `base.ts` + `index.ts` | ~80 行 |
| **P2** | 实现 `orchestration.ts`（将现有 reviewTool 逻辑迁移） | ~60 行 |
| **P3** | 实现 `client.ts` + `config.ts` | ~60 行 |
| **P4** | 实现 `limiter.ts` + `aggregator.ts` | ~100 行 |
| **P5** | 实现 `sampling.ts`（MCP sampling 调度） | ~120 行 |
| **P6** | 实现 `direct_api.ts`（API 调度 + Key 校验） | ~100 行 |
| **P7** | 重构 `reviewTool.ts` + 新增 `getModesTool.ts` | ~80 行 |
| **P8** | 更新 `server.ts` 注入客户端检测 | ~30 行 |
| **P9** | 编写测试 | ~150 行 |

---

## 九、风险与缓解

| 风险 | 级别 | 缓解 |
|------|------|------|
| Token 成本超支 | 🟡 | 预算检查执行前阻断 |
| API Key 泄露 | 🔴 | 仅环境变量 + 日志脱敏 + .gitignore |
| Sampling 速率限制 | 🟡 | Semaphore 限流 + 退避重试 |
| 部分 Persona 失败 | 🟢 | 不中断整体流程，报告标注失败 |
| 配置漂移 | 🟢 | 轻量 json 配置，不存在则全默认 |
