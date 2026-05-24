import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../utils/types.js";
import type { ToolModule } from "./types.js";

export const helpToolDefinition: Tool = {
  name: "kevlar_help",
  description:
    "当用户说「帮助/怎么用/说明」时，调用此工具。显示完整使用帮助，包括功能说明、可用工具和常见问题。",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

const HELP_TEXT = `# Kevlar 使用帮助

## Kevlar 是什么

Kevlar 是一个内容压力测试工具。把你的文案交给多个独立 AI 批评人设，每个人设从不同视角给出犀利的评审意见，帮你发帖前发现潜在问题。

---

## 你能做什么

**开始一次评测**
直接把你的文案/帖子/剧本发给我，我会先列出当前可用的评论员，你勾选想激活的角色（默认全部选中），然后开始评测。

**创建自定义评论员**
直接告诉我你想创建一个人设，我会启动角色构建引擎，分步骤与你互动收集信息（按顺序收集：年龄段 -> 兴趣方向 -> 性格特质 -> 讲话语气 -> 常用平台），确认后为你自动推断文化背景、立场等，并完成最终创建。

**删除评论员**
让我列出所有评论员，你选择要删除的即可。

---

## 适用场景

- **自媒体发帖**：发帖前让不同人设模拟真实读者反应
- **公关舆情红队**：发布声明/通稿前预扫舆论雷区
- **产品评测**：模拟参数党、品牌粉、性价比警察预检评测
- **编剧·剧本杀**：测试剧情闭环、角色动机、玩家代入感

---

## 常见问题

**Q: 安装后如何连接？**
重启你的 AI 客户端即可。

**Q: 自定义评论员可以分享吗？**
可以。评论员文件存储在项目目录的 skills 文件夹中，分享文件给对方即可。

`;

export const helpModule: ToolModule = {
  definition: helpToolDefinition,
  handler: () => async () => {
    return await handleHelp();
  },
};

export async function handleHelp(): Promise<ToolResult> {
  return {
    content: [
      {
        type: "text",
        text: HELP_TEXT,
      },
    ],
  };
}
