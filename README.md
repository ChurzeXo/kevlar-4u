# 🛡️ Kevlar (凯夫拉)

> **Kevlar: A Local-first, MCP-compliant Multi-Agent armor to stress-test your content before the internet does.**
> （Kevlar：一个遵循 MCP 规范的本地多智能体内容防弹衣。在真实的互联网恶评攻击你之前，先在本地完成内容的压力测试。）

![License](https://img.shields.io/github/license/yourusername/kevlar-mcp)
![Version](https://img.shields.io/github/v/release/yourusername/kevlar-mcp?include_prereleases)
![Protocol](https://img.shields.io/badge/protocol-MCP-orange)

---

## 💡 为什么需要 Kevlar？

创作者在发布文案或编写剧本时，往往会陷入**"当局者迷"**的自嗨状态。当我们满怀信心将内容发布到公网上时，迎来的往往不是赞美，而是冷漠、看不懂甚至是无情的恶评。

直面网络暴民会带来强烈的挫败感与情绪内耗。**Kevlar 就是你文字的贴身防弹衣。**

Kevlar 严格遵循 Anthropic 提出的 **Model Context Protocol (MCP)** 规范。它本身不提供任何模型服务（零 Token 成本，绝对隐私），而是作为任务派发层，精妙地指挥你当前正在使用的顶级 AI 客户端（如 Claude Desktop、Cursor）分裂成多个独立的、互不串味的**"读者子代理（Sub-Agents）"**。

在本地安全的沙盒里，让"杠精"、"急性子路人"去帮你的文章挑刺排雷。

---

## ✨ 核心特性

- **🤖 多智能体协同（Multi-Agent Flow）**：不搞大乱炖！Server 会将人设下发，指挥主模型开启独立线程，让子代理分别阅读，拒绝人格串味，大幅提升批判质量。
- **📋 结构化严格输出**：汇总报告强制约束为 `### 用户性格 + 评论内容` 格式，杜绝 AI 闲聊，清晰复盘一眼看穿。
- **🛠️ 动态人设进化（Self-Evolving）**：无需手动写代码。直接对 AI 说 _"帮我搞一个'吹毛求疵的视觉强迫症设计师'人设"_，AI 就会自动补全详细的批判 Prompt 并直接写入本地 `skills/` 目录。
- **🔒 本地优先与绝对隐私 (Local-First)**：未公开发表的文案是绝对的商业机密。Kevlar 完全运行在本地，支持客户端无缝接入本地 Ollama（如运行 DeepSeek-R1 / Llama3），彻底断绝隐私泄露。
- **🧩 模块化无冲突**：每个人格都是一个独立的 `.md` 文件，采用 Frontmatter (YAML) 管理元数据，开源社区提交新角色时**绝不产生 Git 合并冲突**。

---

## 📂 架构与目录树

```text
kevlar/
├── .github/
│   └── workflows/
│       └── release.yml
├── config/
│   └── mcp-config.json          # 供本地测试参考的客户端配置文件
├── skills/                      # 核心资产：分布式防弹人格库
│   ├── _template.md             # 引导社区贡献的人设模版
│   ├── keyboard_warrior.md      # 杠精/键盘侠（专挑逻辑漏洞）
│   └── impatient_passerby.md    # 急性子路人（测试前三秒流存率）
├── src/
│   ├── index.ts                 # 入口文件（启动 Stdio 监听）
│   ├── server.ts                # MCP Server 核心控制类（处理握手与协议）
│   ├── tools/                   # MCP Tools 矩阵（智能体功能单元）
│   │   ├── index.ts             # 工具统一注册中心
│   │   ├── reviewTool.ts        # 1. 压力测试调度引擎
│   │   ├── createPersonaTool.ts # 2. 动态人设写入引擎
│   │   └── listPersonasTool.ts  # 3. 现有性格扫描引擎
│   └── utils/
│       └── parser.ts            # Markdown Frontmatter 解析器
├── scripts/                     # CLI 及工具脚本
│   ├── cli.ts                   # 命令行入口
│   ├── registry.ts              # 人设注册管理
│   └── setup.ts                 # 项目初始化配置
├── package.json
└── tsconfig.json
```
