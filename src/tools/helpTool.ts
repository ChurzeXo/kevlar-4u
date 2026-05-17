import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const helpToolDefinition: Tool = {
  name: "kevlar_help",
  description:
    "显示 Kevlar 的完整使用帮助，包括功能说明、可用工具和常见问题。",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

const HELP_TEXT = `# Kevlar 使用帮助

## Kevlar 是什么

Kevlar 是一个 Local-first 的 MCP 内容压力测试工具。把你的文案交给多个独立 AI 批评人设，每个人设从不同视角给出犀利的评审意见，帮你发帖前发现潜在问题。

---

## 可用工具

### review_content
将你的文案/剧本/内容交给多个独立批评人设进行压力测试。

**使用流程：**
1. 调用 \`list_personas\` 查看当前可用评论员
2. 调用 \`review_content\` 传入文案（可选指定 \`persona_ids\` 筛选评论员）
3. 评测完成后，如有未参与的评论员，可继续追加测试

### list_personas
列出当前所有可用批评人设，包括 ID、名称、描述和标签。

### create_persona
创建新评论员。AI 会引导你提供以下信息并用 \`&\` 分隔：
\`名称&性格描述&批判视角&标签\`

### delete_persona
删除一个已存在的评论员。删除系统内置角色后可通过 \`reset_personas\` 恢复。

### reset_personas
恢复所有系统内置默认评论员（急性子路人甲、键盘侠·杠精模式、第一次听说·路人读者）。

---

## 内置评论员说明

| 角色 | 擅长发现 |
|------|---------|
| 急性子路人甲 | 前三秒留存率、可读性、传播价值 |
| 键盘侠·杠精模式 | 逻辑漏洞、事实错误、绝对化表述 |
| 第一次听说·路人读者 | 产品定位清晰度、信息传达效率 |

---

## 适用场景

- **自媒体发帖**：发帖前让不同人设模拟真实读者反应
- **公关舆情红队**：发布声明/通稿前预扫舆论雷区
- **产品评测**：模拟参数党、品牌粉、性价比警察预检评测
- **编剧·剧本杀**：测试剧情闭环、角色动机、玩家代入感

---

## 常见问题

**Q: 安装后如何连接？**
重启你的 AI 客户端即可。连接成功会看到 Kevlar 工具列表。

**Q: 评论员文件存在哪里？**
所有评论员文件存储在项目根目录的 \`skills/\` 文件夹中，每个文件是一个 Markdown 格式的人设定义。

**Q: 自定义评论员可以被其他人使用吗？**
可以。评论员文件是本地文件，分享 \`skills/xxx.md\` 给对方即可。

**Q: 如何重置所有设置？**
删除 \`skills/\` 下不需要的文件，然后调用 \`reset_personas\` 恢复系统内置角色。`;

export async function handleHelp(): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  return {
    content: [
      {
        type: "text",
        text: HELP_TEXT,
      },
    ],
  };
}
