import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import { validateWritePath, writePersonaFile, PersonaMeta } from "../utils/parser.js";
import { ToolResult } from "../utils/types.js";

export const SYSTEM_PROMPT = `你是一个角色构建引擎，负责通过阶段式对话收集用户输入，创建用于内容评论的虚拟读者人设。

## 一、阶段式收集流程

按以下顺序逐一提问，每个字段用户确认后再进入下一个，不得跳步。

---

**第一步：年龄段**

向用户提问：
请问这个角色的年龄段是？（例如：18-24岁、30-35岁）

用户回答后，直接记录，向用户确认：
年龄段：XX岁，确认没问题吗？

确认后写入临时记忆文档。

---

**第二步：兴趣方向**

向用户提问：
请描述这个角色的兴趣方向，可以自由描述，不需要使用特定格式。

用户回答后，将内容提炼为不超过3个标签，向用户确认：
我帮你总结为以下标签：
兴趣方向：标签A、标签B、标签C
确认没问题吗？如需调整请直接告诉我。

确认后写入临时记忆文档。

---

**第三步：性格特质**

向用户提问：
请描述这个角色的性格特质，可以自由描述，不需要使用特定格式。

用户回答后，将内容提炼为不超过4条「特质 → 行为」格式的标签，向用户确认：
我帮你总结为以下内容：
性格特质：
- 特质 → 因此当 X 时，我会 Y
- 特质 → 因此当 X 时，我会 Y
确认没问题吗？如需调整请直接告诉我。

提炼规则：
- 每条特质必须连接一个具体行为描述
- 行为描述不限于理性行为，情绪反应、直觉反应、社交反应同样有效
- 禁止出现孤立的形容词描述

确认后写入临时记忆文档。

---

**第四步：常用平台**

向用户提问：
请问这个角色主要用于评论哪个平台的内容？（例如：微信公众号、小红书、Instagram、Twitter/X、YouTube、Reddit 等）

用户回答后，直接记录，向用户确认：
常用平台：XX，确认没问题吗？

确认后写入临时记忆文档。

---

## 二、中途修改机制

用户在任意阶段提出修改已确认内容时：
1. 允许回退至对应字段重新提炼或记录
2. 更新临时记忆文档中对应内容
3. 更新完成后继续当前未完成的步骤

---

## 三、最终确认与创建

所有字段收集完毕后，向用户发出最终确认：
所有信息已收集完毕，确认没有问题的话，我就开始创建角色了。

用户确认后：
1. 读取临时记忆文档
2. 执行模型自动推断（见第四部分）
3. 输出完整角色描述
4. 删除临时记忆文档

删除时只删除本次创建流程生成的临时记忆文档，不得删除其他任何内容。

---

## 四、模型自动推断项

读取临时记忆文档后，根据用户确认内容自动推断以下项目，推断过程不对用户展示：

**1. 输入语言**
自动识别用户输入所使用的语言，作为文化背景推断的基础信号。

**2. 文化背景**
综合输入语言与常用平台推断该角色最可能归属的文化语境。
示例逻辑：
- 中文 + 小红书 → 中国大陆年轻用户文化语境
- 中文 + Instagram → 海外华人社区语境
- 英文 + Reddit → 欧美互联网文化语境
文化背景将影响角色的表达方式、信任阈值和行为反应模式。

**3. 与作者的关系**
根据兴趣方向和性格特质推断：
- 已关注：信任阈值较高，但期望值也更高，容易因内容质量下滑而失望
- 未关注：信任阈值较低，更容易因细节问题流失注意力

**4. 立场**
根据兴趣方向、性格特质、文化背景综合推断：
- 默认信任：倾向于先接受内容，再寻找共鸣点
- 默认质疑：倾向于先审视内容，再决定是否接受
如用户在收集阶段明确声明立场，以用户声明为准，忽略推断结果。

**5. 盲区**
根据角色的性格、兴趣、文化背景推断其认知边界。超出边界的维度，角色在评论阶段不发表意见，也不假装具备相关感知能力。若无明显盲区，必须明确输出“无特定盲区”。

---

## 五、角色输出格式

按以下格式输出，不显示任何分组标题：

年龄段：
兴趣方向：
常用平台：
性格特质：
- 特质 → 行为
- 特质 → 行为

文化背景：
与作者的关系：
立场：
盲区：`;

export const updatePersonaDraftToolDefinition: Tool = {
  name: "update_persona_draft",
  description: "每步用户确认后由 LLM 调用，更新对应字段的临时记忆",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "会话唯一标识，格式：[a-z0-9-]",
      },
      field: {
        type: "string",
        enum: ["ageRange", "interests", "traits", "platform"],
        description: "需要更新的字段名",
      },
      value: {
        type: ["string", "array"],
        items: { type: "string" },
        description: "字段值（支持字符串或字符串数组）",
      },
    },
    required: ["sessionId", "field", "value"],
  },
};

export const deletePersonaDraftToolDefinition: Tool = {
  name: "delete_persona_draft",
  description: "角色创建成功后由 LLM 调用，删除临时记忆文件",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "会话唯一标识，格式：[a-z0-9-]",
      },
    },
    required: ["sessionId"],
  },
};

export const createPersonaToolDefinition: Tool = {
  name: "create_persona",
  description:
    "动态创建并保存一个新的批评人设。当你对 AI 说「帮我创建一个XXX人设」时，AI 会生成完整的角色 Prompt 并保存，之后即可在评测中使用。",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: {
        type: "string",
        description:
          "人设的唯一英文 ID（小写字母、数字、下划线），用于文件名和后续调用，例如：picky_designer",
      },
      name: {
        type: "string",
        description: "人设的中文名称，例如：挑剔的视觉强迫症设计师",
      },
      name_en: {
        type: "string",
        description: "人设的英文名称，例如：Picky Visual OCD Designer",
      },
      description: {
        type: "string",
        description: "一句话描述这个人设的核心特质",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "标签数组，方便分类，例如 [\"设计\", \"视觉\", \"挑剔\"]",
      },
      
      sessionId: {
        type: "string",
        description: "当前会话 ID（如果有临时记忆）",
      },
      author: {
        type: "string",
        description: "创建者署名（可选），默认为 ai-generated",
      },
    },
    required: ["name"],
  },
};

export interface CreatePersonaInput {
  id?: string;
  name: string;
  name_en?: string;
  description?: string;
  tags?: string[];
  author?: string;
  sessionId?: string;
}

export async function handleSaveDraft(
  tmpDir: string,
  input: CreatePersonaInput
): Promise<any> {
  if (!input.sessionId) return null;
  const fileName = `${input.sessionId}_draft.json`;
  const filePath = path.join(tmpDir, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error("临时记忆文件不存在");
  }
  const data = await fs.promises.readFile(filePath, "utf-8");
  return JSON.parse(data);
}

export async function handleCreatePersona(
  skillsDir: string,
  tmpDir: string,
  input: CreatePersonaInput
): Promise<ToolResult> {
  let draft: any = null;
  try {
    draft = await handleSaveDraft(tmpDir, input);
  } catch (err) {
    return {
      content: [{ type: "text", text: `❌ 读取草稿失败：${String(err)}` }],
      isError: true,
    };
  }

  const id = input.id || input.name.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() || `persona_${Date.now().toString(36)}`;
  const description = input.description || "由模型推断自动生成的角色";

  if (!/^[a-z0-9_]+$/.test(id)) {
    return {
      content: [{ type: "text", text: `❌ 名称格式不合法，只能包含小写英文字母、数字和下划线。` }],
      isError: true,
    };
  }

  const fileName = `${id}.md`;
  const filePath = path.join(skillsDir, fileName);

  if (!validateWritePath(filePath, skillsDir)) {
    return {
      content: [{ type: "text", text: `❌ 非法路径访问被拒绝。` }],
      isError: true,
    };
  }

  if (fs.existsSync(filePath)) {
    return {
      content: [{ type: "text", text: `⚠️ 这个评论员名称已存在。请换个名称，或先删除旧的再创建。` }],
      isError: true,
    };
  }

  const meta: PersonaMeta = {
    id,
    name: input.name,
    name_en: input.name_en ?? "",
    version: "1.0.0",
    author: input.author ?? "ai-generated",
    tags: input.tags ?? [],
    description,
  };

  let personaDescription = "";
  if (draft && draft.fields) {
    personaDescription += `年龄段：${draft.fields.ageRange || ''}\n`;
    personaDescription += `兴趣方向：${Array.isArray(draft.fields.interests) ? draft.fields.interests.join('、') : (draft.fields.interests || '')}\n`;
    personaDescription += `常用平台：${draft.fields.platform || ''}\n`;
    personaDescription += `性格特质：\n`;
    if (Array.isArray(draft.fields.traits)) {
      draft.fields.traits.forEach((t: string) => personaDescription += `- ${t}\n`);
    }
  } else {
    personaDescription = "未提供角色具体描述";
  }

  try {
    await writePersonaFile(skillsDir, meta, personaDescription);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `❌ 写入文件失败：${message}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: [
          `✅ 人设「${input.name}」已成功创建！`,
          "",
          `描述：${description}`,
          "",
          "现在即可在评测中选择使用这个评论员。"
        ].join("\n"),
      },
    ],
  };
}
export interface UpdatePersonaDraftInput {
  sessionId: string;
  field: "ageRange" | "interests" | "traits" | "platform";
  value: string | string[];
}

export async function handleUpdatePersonaDraft(
  tmpDir: string,
  input: UpdatePersonaDraftInput
): Promise<ToolResult> {
  if (!/^[a-z0-9-]+$/.test(input.sessionId)) {
    return {
      content: [{ type: "text", text: `❌ sessionId 格式不合法` }],
      isError: true,
    };
  }

  const fileName = `${input.sessionId}_draft.json`;
  const filePath = path.join(tmpDir, fileName);

  if (!path.resolve(filePath).startsWith(path.resolve(tmpDir))) {
    return {
      content: [{ type: "text", text: `❌ 非法路径访问被拒绝` }],
      isError: true,
    };
  }

  let draft: any = {
    sessionId: input.sessionId,
    createdAt: Date.now(),
    step: 1,
    fields: {},
  };

  try {
    if (!fs.existsSync(tmpDir)) {
      await fs.promises.mkdir(tmpDir, { recursive: true });
    }
    if (fs.existsSync(filePath)) {
      const data = await fs.promises.readFile(filePath, "utf-8");
      draft = JSON.parse(data);
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `❌ 读取草稿文件失败: ${String(err)}` }],
      isError: true,
    };
  }

  if (draft.sessionId !== input.sessionId) {
    return {
      content: [{ type: "text", text: `❌ 会话归属校验失败` }],
      isError: true,
    };
  }

  const stepMapping: Record<string, number> = {
    ageRange: 1,
    interests: 2,
    traits: 3,
    platform: 4,
  };
  
  if (stepMapping[input.field]) {
    draft.step = Math.max(draft.step, stepMapping[input.field]);
  }

  draft.fields[input.field] = input.value;

  try {
    await fs.promises.writeFile(filePath, JSON.stringify(draft, null, 2), "utf-8");
  } catch (err) {
    return {
      content: [{ type: "text", text: `❌ 写入草稿文件失败: ${String(err)}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: `✅ 草稿字段 ${input.field} 更新成功` }],
  };
}

export interface DeletePersonaDraftInput {
  sessionId: string;
}

export async function handleDeletePersonaDraft(
  tmpDir: string,
  input: DeletePersonaDraftInput
): Promise<ToolResult> {
  if (!/^[a-z0-9-]+$/.test(input.sessionId)) {
    return {
      content: [{ type: "text", text: `❌ sessionId 格式不合法` }],
      isError: true,
    };
  }

  const fileName = `${input.sessionId}_draft.json`;
  const filePath = path.join(tmpDir, fileName);

  if (!path.resolve(filePath).startsWith(path.resolve(tmpDir))) {
    return {
      content: [{ type: "text", text: `❌ 非法路径访问被拒绝` }],
      isError: true,
    };
  }

  if (!fs.existsSync(filePath)) {
    return {
      content: [{ type: "text", text: `⚠️ 找不到对应的临时记忆文件` }],
    };
  }

  try {
    const data = await fs.promises.readFile(filePath, "utf-8");
    const draft = JSON.parse(data);
    if (draft.sessionId !== input.sessionId) {
      return {
        content: [{ type: "text", text: `❌ 会话归属校验失败` }],
        isError: true,
      };
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `❌ 读取或校验草稿文件失败: ${String(err)}` }],
      isError: true,
    };
  }

  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    return {
      content: [{ type: "text", text: `❌ 删除草稿文件失败: ${String(err)}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: `✅ 草稿删除成功` }],
  };
}
