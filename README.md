# Kevlar MCP Servers

> **Kevlar: A Local-first, MCP-compliant Multi-Agent armor to stress-test your content before the internet does.**
> （Kevlar：一个遵循 MCP 规范的本地多智能体内容防弹衣。在真实的互联网恶评攻击你之前，先在本地完成内容的压力测试。）

![License](https://img.shields.io/github/license/yourusername/kevlar-mcp)
![Version](https://img.shields.io/github/v/release/yourusername/kevlar-mcp?include_prereleases)
![Protocol](https://img.shields.io/badge/protocol-MCP-orange)

---

## 💡 为什么需要 Kevlar？

创作者在发布文案、宣发推文或编写视频剧本时，往往会陷入**“当局者迷”**的自嗨状态。当我们满怀信心将内容发布到公网上时，迎来的往往不是赞美，而是冷漠、看不懂甚至是无情的恶评与舆论翻车。

直面网络暴民会带来强烈的挫败感与情绪内耗。**Kevlar 就是你文字与内容的安全防护网（防弹衣）。**

Kevlar 严格遵循 Anthropic 提出的 **Model Context Protocol (MCP)** 规范。它本身不直接绑定任何特定的收费模型服务，而是作为智能的执行与派发层，精妙地指挥你当前正在使用的顶级 AI 客户端（如 Claude Desktop、Cursor）分裂成多个独立的、互不串味的**“读者子代理（Sub-Agents）”**。

在本地安全的沙盒里，让“杠精”、“急性子路人”、“视觉强迫症”去帮你的文章挑刺排雷，在发布前发现所有潜在的舆论和逻辑隐患。

---

## ✨ 核心特性

- **🤖 多智能体协同（Multi-Agent Flow）**：不搞角色大乱炖！Server 会将不同人设分别下发并进行物理隔离或精准 Prompt 约束，让各子代理独立评审，拒绝人格串味，大幅提升批判质量。
- **🚀 三大灵活执行模式（Flexible Execution Modes）**：支持 **Orchestration 编排代理**（零 Token 成本）、**MCP Sampling 并行采样**（深度高隔离）及 **Direct API 直连模式**（无 MCP 客户端环境），完美适应所有开发与使用场景。
- **📋 结构化严格输出**：汇总报告强制约束为结构化评测模式，包含各角色的尖锐吐槽、痛点分析与改进建议，杜绝 AI 闲聊，清晰复盘一眼看穿。
- **🛠️ 动态人设进化（Self-Evolving Personas）**：无需编写任何代码。只需向 AI 表达 _“帮我搞一个吹毛求疵的科技博主角色”_，AI 就会自动补全详细的批判 Prompt 并直接写入本地人设库。
- **🔒 本地优先与隐私安全（Local-First & Safety）**：未公开的文案是绝对的机密。Kevlar 完全运行在本地，支持对接本地 Ollama（如运行 DeepSeek-R1 / Llama3 等），并具备严格的 API Key 脱敏和本地 `.gitignore` 过滤，彻底断绝隐私泄露风险。
- **🧩 模块化无冲突设计**：每个人格都是一个独立的 `.md` 文件，采用 Frontmatter (YAML) 管理元数据，开源社区提交新角色时**绝不产生 Git 合并冲突**。

---

## 📂 架构与目录树

经过近期的架构调整，Kevlar 引入了完善的**多模式执行层 (Execution Layer)**、**配置中心**、**限流与并发控制**等模块。最新的项目目录树如下：

```text
kevlar/
├── .github/
│   └── workflows/
│       └── release.yml
├── config/
│   └── mcp-config.json          # 供本地测试/客户端配置的参考文件
├── docs/
│   └── SPEC-execution-modes.md  # 详细的多执行模式技术规格说明书
├── skills/                      # 核心资产：分布式防弹人格库
│   ├── _template.md             # 引导社区贡献的人设模版
│   ├── keyboard_warrior.md      # 键盘侠/杠精（专挑逻辑漏洞与常识性错误）
│   ├── impatient_passerby.md    # 急性子路人（测试前3秒内容留存率）
│   └── kevlar-config.json       # 用户个性化配置文件（已加入 .gitignore，安全无感）
├── src/
│   ├── index.ts                 # 入口文件（启动 Stdio 监听）
│   ├── server.ts                # MCP Server 核心控制类（处理握手、工具注册与协议分发）
│   ├── execution/               # 🚀 执行层（新增的核心架构）
│   │   ├── index.ts             # 统一执行入口与模式分发
│   │   ├── base.ts              # 执行接口、上下文及类型定义
│   │   ├── client.ts            # 客户端能力检测（Sampling 支持性判断）
│   │   ├── config.ts            # kevlar-config.json 读写控制器
│   │   ├── aggregator.ts        # 多智能体评审报告聚合器
│   │   ├── limiter.ts           # 并发限流器（Semaphore 信号量 + 指数退避）
│   │   ├── lock.ts              # 并发评测锁（防多任务资源冲突）
│   │   └── modes/               # 执行模式具体实现
│   │       ├── index.ts         # 模式注册中心
│   │       ├── orchestration.ts # 1. Orchestration 编排代理模式
│   │       ├── sampling.ts      # 2. MCP Sampling 并行采样模式
│   │       └── direct_api.ts    # 3. Direct API 直连模式
│   ├── tools/                   # MCP Tools 矩阵（智能体功能单元）
│   │   ├── index.ts             # 工具统一注册与管理
│   │   ├── reviewTool.ts        # 内容压力测试调度工具 (review_content)
│   │   ├── getModesTool.ts      # 查询当前可用执行模式与状态 (get_execution_modes)
│   │   ├── configureTool.ts     # 修改持久化运行配置 (configure)
│   │   ├── createPersonaTool.ts # 动态人设写入工具 (create_persona)
│   │   ├── deletePersonaTool.ts # 人设删除工具 (delete_persona)
│   │   ├── listPersonasTool.ts  # 现有性格列表扫描工具 (list_personas)
│   │   ├── resetPersonasTool.ts # 人设库重置工具 (reset_personas)
│   │   └── helpTool.ts          # 帮助与指引工具 (help)
│   └── utils/
│       ├── types.ts             # 共享 TypeScript 类型
│       ├── parser.ts            # Markdown Frontmatter / YAML 解析器
│       └── errors.ts            # 错误码与全局异常处理器
├── package.json
└── tsconfig.json
```

---

## 🚀 多执行模式详解 (Execution Modes)

Kevlar 设计了三种不同的执行模式，以满足各种客户端环境和预算要求。

### 3.1 三大模式对比

| 模式 | 标识符 | 工作原理 | Token 成本 | 物理并行性 | 核心依赖 | 适用场景 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **编排代理模式** *(默认)* | `orchestration` | Server 将所有 Persona 指令聚合到**单次 Prompt** 中，一次性发送给宿主 AI 客户端执行。 | 🪙 **零额外成本**<br>(Kevlar 本身不调用模型) | 否 *(宿主单次执行)* | 宿主模型的上下文与理解力 | 追求简单开箱即用、免去 API 费用、宿主模型能力强。 |
| **MCP Sampling 模式** | `mcp_sampling` | Kevlar 为每个 Persona 发起独立的 MCP `sampling/createMessage` 调用，实现真正的多智能体执行。 | 💸 **宿主端承担** | **是** *(真正的并行多Agent)* | 宿主客户端必须支持 MCP Sampling 规范 | 需要完全的物理隔离、彻底避免人格串味、追求极佳的多视角批判深度。 |
| **Direct API 模式** | `direct_api` | Kevlar 直接通过网络调用第三方大模型 API (OpenAI / Anthropic / Ollama 等)。 | 💳 **用户自备 API Key** | **是** *(真正的并行多Agent)* | 需配置环境变量 API Key | 宿主客户端不支持 Sampling（如普通 IDE 插件）或处于无 MCP 客户端的自动化脚本环境。 |

---

### 3.2 自动协商降级链 (`auto` 模式逻辑)

当用户指定模式为 `auto`（默认值）时，Kevlar 将启动智能检测与降级协商机制，流程如下：

```mermaid
graph TD
    A[用户触发 review_content 且 mode=auto] --> B{"kevlar-config.json 有持久化配置吗?"}
    B -- "是 (非 auto)" --> C[直接使用配置的特定模式]
    B -- "否 / 为 auto" --> D{"宿主客户端支持 MCP Sampling?"<br><i>(通过 initialize 握手检测 clientInfo)</i>}
    D -- "是 (如 Claude Desktop 等支持客户端)" --> E[<b>使用 mcp_sampling 模式</b>]
    D -- "否" --> F{"检测到 API Key 环境变量?"<br><i>(KEVLAR_API_KEY / ANTHROPIC_API_KEY 等)</i>}
    F -- "是" --> G[<b>使用 direct_api 模式</b>]
    F -- "否" --> H[<b>兜底使用 orchestration 模式</b><br><i>(永远可用)</i>]
```

> [!NOTE]
> - **客户端检测**：MCP 握手阶段，Kevlar 通过 `clientInfo.name` 检测宿主客户端能力（例如 `claude-ai`）。对于未确认的客户端，如果用户强行选择 `mcp_sampling`，Kevlar 将在失败时优雅降级并给出明确的终端提示。

---

## ⚙️ 交互式配置与模式切换

用户无需记忆繁琐的命令行或手动编辑 JSON 配置文件。Kevlar 内置了高情商的 AI 交互流，宿主大模型能够感知配置工具并引导用户操作。

### 4.1 交互流程示范

```text
🧑 用户: "帮我看一下评测模式，能切换一下吗？"

🤖 AI: (自动调用 get_execution_modes 工具) 
       -> 返回当前可用模式列表与环境状态
       -> 以精美的 Markdown 表格向用户展示：
       
       | 模式 | 状态 | 说明 |
       |------|------|------|
       | 编排代理模式 (orchestration) | ✅ 可用 | 单次 Prompt 调用，零 Token 成本，简单可靠 |
       | MCP 采样模式 (mcp_sampling) | ✅ 可用 | 物理并行，深度多角度分析 |
       | 直接 API 模式 (direct_api) | ❌ 未配置 API Key | 需在环境变量设置 KEVLAR_API_KEY |
       
       "您当前处于 `auto` (自动选择) 状态，系统为您推荐使用 `mcp_sampling`。请问需要为您切换吗？"

🧑 用户: "那就换成采样模式吧。"

🤖 AI: (自动调用 configure { "mode": "mcp_sampling" } 工具)
       -> 写入 skills/kevlar-config.json 配置文件
       "已成功为您切换为 MCP 采样模式！下一次内容压力测试将立即生效，无需重启客户端。"
```

### 4.2 运行配置结构 (`skills/kevlar-config.json`)
非敏感偏好设置将自动写入 `skills/kevlar-config.json`。该文件已被列入 `.gitignore`，既保证了配置的本地持久化，又避免了将个人偏好提交到公共仓库。
```json
{
  "mode": "auto",
  "multiAgent": {
    "maxConcurrency": 3,
    "timeoutMs": 60000
  },
  "personaOrder": [],
  "createdAt": "2026-05-18T10:00:00Z",
  "updatedAt": "2026-05-18T10:15:00Z"
}
```

---

## 🔒 安全、预算与资源控制

为了保障在大规模并发或 API 直连情况下的安全与系统稳定性，Kevlar 构建了坚固的防护设计：

### 5.1 API Key 安全管理 (Security First)
*   **零本地留存**：API Key **绝不**允许写入 `skills/kevlar-config.json` 等本地配置文件，禁止通过工具参数传递。
*   **环境变量读取优先级**：`KEVLAR_API_KEY` (首选) > `ANTHROPIC_API_KEY` (次选) > `OPENAI_API_KEY` (末选)。
*   **日志严格脱敏**：控制台与调试日志中，所有 API Key 均会通过掩码正则处理（例如：`sk-ant-****abcd`），严防密钥在截屏或日志排查时泄漏。

### 5.2 Token 自动预算控制 (Token Budget Control)
为了防止多智能体并行调用产生的非预期账单，在 `mcp_sampling` 和 `direct_api` 执行前，Kevlar 会启动强预算检查：
*   **预估公式**：`预估消耗 = (输入内容长度 / 4) + (评审角色数 * 10,000)`。
*   **阻断阀值**：单次评测任务预估上限默认为 `50,000 Tokens`，单个人设上限 `10,000 Tokens`。
*   **行为**：一旦预估值超出阀值（可通过 `KEVLAR_TOKEN_BUDGET_PER_TASK` 环境变量自定义），Kevlar 将在**执行前主动阻断并报错**，保护用户钱包。

### 5.3 流控与防并发锁 (Limiter & Lock)
*   **并发锁**：由于多智能体模式涉及外部大模型接口调用，Kevlar 在调用 `review_content` 时会自动申请 `reviewLock`，**禁止并发运行两个多智能体评测任务**（Orchestration 模式不受此限），避免资源竞争与混乱。
*   **并发限流器**：内置 `RateLimiter` 信号量，控制多角色执行时的最大并行请求数（默认 `KEVLAR_MAX_CONCURRENT=3`）以及最小请求延迟（默认 `KEVLAR_MIN_DELAY_MS=1000`）。
*   **指数退避重试**：网络抖动或触发平台速率限制 (Rate Limit) 时，自动启动指数退避重试（最多重试 3 次，间隔 1s、2s、4s），保障复杂任务的最终交付。
*   **部分容错与降级**：若某个人设由于网络原因评测失败，系统不会强行中断其他角色的评审。最终报告中会保留成功者的发言，并在页眉/页脚以部分失败（Partial Failures）标明受损的角色与原因。

---

## 📊 报告模式标注 (Attribution)

每次压力测试结束后，Kevlar 会在生成的 Markdown 汇总报告中显著标注当前的执行情况，确保用户完全掌控底层细节。

*   **编排代理模式**：会在生成的报告底部附加 `*执行模式：编排代理模式*`。
*   **采样 / 直连 API 模式**：会在生成的报告头部以醒目的元数据区域标出：
    ```markdown
    > 🛡️ **Kevlar 内容防弹评审报告**
    > **执行模式**：MCP 采样模式 (mcp_sampling)
    > **参与评论员**：急性子路人甲、键盘侠·杠精模式（共 2 位）
    > **部分失败**：无
    ```

---

## 🛠️ 环境变量配置清单 (Environment Variables)

你可以通过在启动命令前注入或在环境变量文件中定义以下参数来微调 Kevlar 的行为：

| 环境变量 | 默认值 | 可选值 | 说明 |
| :--- | :--- | :--- | :--- |
| `KEVLAR_MODE` | `auto` | `auto` \| `orchestration` \| `mcp_sampling` \| `direct_api` | 全局首选执行模式，会被 `kevlar-config.json` 的用户配置覆盖。 |
| `KEVLAR_API_KEY` | *(无)* | `sk-...` | Direct API 模式下的首选 API Key，支持 OpenAI 与 Anthropic 格式。 |
| `ANTHROPIC_API_KEY` | *(无)* | `sk-ant-...` | Anthropic 官方 Key。 |
| `OPENAI_API_KEY` | *(无)* | `sk-...` | OpenAI 官方 Key。 |
| `KEVLAR_TOKEN_BUDGET_PER_TASK` | `50000` | 正整数 | 单次多智能体评审任务的最大预估 Token 预算。超过则安全阻断。 |
| `KEVLAR_MAX_CONCURRENT` | `3` | 正整数 | 多角色并行评审时的最大并发请求数，防止触发下游限流。 |
| `KEVLAR_MIN_DELAY_MS` | `1000` | 毫秒 | 并行请求之间的最小延迟间隔，缓解下游接口压力。 |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` | 日志打印级别。 |

---

## 🚀 快速开始与客户端配置

### 6.1 构建项目

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run build
```

### 6.2 配置 Claude Desktop

在 Claude Desktop 的配置文件中（Mac 路径为 `~/Library/Application Support/Claude/claude_desktop_config.json`）添加 Kevlar 服务器：

```json
{
  "mcpServers": {
    "kevlar": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/kevlar/dist/index.js"],
      "env": {
        "KEVLAR_MODE": "auto",
        "KEVLAR_MAX_CONCURRENT": "3"
      }
    }
  }
}
```

### 6.3 配置 Cursor / 其他客户端

在 Cursor -> Settings -> Features -> MCP 中添加：
*   **Name**: `kevlar`
*   **Type**: `command`
*   **Command**: `node /ABSOLUTE/PATH/TO/kevlar/dist/index.js`

---

## 🤝 贡献防弹人设

我们鼓励社区贡献更多尖锐、刁钻的内容评审角色！只需在 `skills/` 目录下创建一个新的 `.md` 文件，并遵循以下结构：

```markdown
---
id: your_persona_id
name: 角色显示名称
description: 角色特性的简短介绍，供工具扫描展示。
priority: 10
---

# 角色系统指令 (System Prompt)

你是一个【具体的人格设定描述】。
你的任务是以最严苛的角度阅读用户输入的内容，指出其中的【关注痛点】。

## 评审维度
1. 维度一
2. 维度二

## 输出格式约束
必须直接输出你的第一人称真实吐槽，杜绝废话和寒暄。
```

---

*“在被真实的互联网恶评击碎前，让 Kevlar 成为你最坚实的防弹衣。”*
