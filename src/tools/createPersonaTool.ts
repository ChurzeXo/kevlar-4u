import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import matter from "gray-matter";
import { validateWritePath, PersonaMeta } from "../utils/parser.js";

// 统一返回类型定义
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

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
      system_prompt: {
        type: "string",
        description:
          "完整的角色系统提示词（Markdown 格式），描述角色身份、性格特质、阅读习惯、批判视角和严格的输出格式要求。输出格式必须包含「### {角色名} · 评论」标题块。",
      },
      author: {
        type: "string",
        description: "创建者署名（可选），默认为 ai-generated",
      },
    },
    required: ["id", "name", "system_prompt", "description"],
  },
};

export interface CreatePersonaInput {
  id: string;
  name: string;
  name_en?: string;
  description: string;
  tags?: string[];
  system_prompt: string;
  author?: string;
}

export async function handleCreatePersona(
  skillsDir: string,
  input: CreatePersonaInput
): Promise<ToolResult> {
  // Validate ID format
  if (!/^[a-z0-9_]+$/.test(input.id)) {
    return {
      content: [
        {
          type: "text",
          text: `❌ 名称格式不合法，只能包含小写英文字母、数字和下划线。`,
        },
      ],
      isError: true,
    };
  }

  const fileName = `${input.id}.md`;
  const filePath = path.join(skillsDir, fileName);

  // Security check: validate path is within skillsDir
  if (!validateWritePath(filePath, skillsDir)) {
    return {
      content: [
        {
          type: "text",
          text: `❌ 非法路径访问被拒绝。`,
        },
      ],
      isError: true,
    };
  }

  // Check for existing file
  if (fs.existsSync(filePath)) {
    return {
      content: [
        {
          type: "text",
          text: `⚠️ 这个评论员名称已存在。请换个名称，或先删除旧的再创建。`,
        },
      ],
      isError: true,
    };
  }

  // Define proper Frontmatter type
  const meta: PersonaMeta = {
    id: input.id,
    name: input.name,
    name_en: input.name_en ?? "",
    version: "1.0.0",
    author: input.author ?? "ai-generated",
    tags: input.tags ?? [],
    description: input.description,
  };

  try {
    fs.mkdirSync(skillsDir, { recursive: true });
    const fileContent = matter.stringify(input.system_prompt, meta);
    fs.writeFileSync(filePath, fileContent, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `❌ 写入文件失败：${message}`,
        },
      ],
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
          `描述：${input.description}`,
          "",
          "现在即可在评测中选择使用这个评论员。",
        ].join("\n"),
      },
    ],
  };
}
