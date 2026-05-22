import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import {
	validateWritePath,
	writePersonaFile,
	PersonaMeta,
} from "../utils/parser.js";
import { ToolResult } from "../utils/types.js";

export const updatePersonaDraftToolDefinition: Tool = {
	name: "update_persona_draft",
	description: `角色构建草稿暂存工具。在人设创建流程中暂存各个字段（ageRange, interests, traits, platform, authorRelation）的值，最终调用 create_persona 完成创建。`,
	inputSchema: {
		type: "object",
		properties: {
			sessionId: {
				type: "string",
				description: "会话唯一标识，格式：[a-z0-9-]",
			},
			field: {
				type: "string",
				enum: ["ageRange", "interests", "traits", "platform", "authorRelation"],
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
		"正式创建并保存一个新的批评人设。支持通过 sessionId 读取已完成的临时草稿完成高精度创建，也支持直接通过 id、name_en、description 和 tags 等参数进行直接一步创建。",
	inputSchema: {
		type: "object" as const,
		properties: {
			name: {
				type: "string",
				description: "人设的中文名称，例如：挑剔的视觉强迫症设计师",
			},
			id: {
				type: "string",
				description:
					"唯一标识符（可选），只能包含小写英文字母、数字和下划线，例如：fast_critic",
			},
			name_en: {
				type: "string",
				description: "英文名称（可选），例如：Fast Critic",
			},
			description: {
				type: "string",
				description: "人设一句话描述（可选），如果不提供且有草稿则自动推断",
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: '人设标签数组（可选），例如：["设计", "视觉", "挑剔"]',
			},
			sessionId: {
				type: "string",
				description:
					"当前会话 ID（可选，若提供则基于已完成的草稿来创建角色）",
			},
			author: {
				type: "string",
				description: "创建者署名（可选），默认为 ai-generated",
			},
			culturalContext: {
				type: "string",
				description: "文化背景（模型推断，可选）",
			},
			authorRelation: {
				type: "string",
				description: "与作者的关系（模型推断，可选）",
			},
			stance: {
				type: "string",
				description: "立场（模型推断，可选）",
			},
			blindSpot: {
				type: "string",
				description: "盲区（模型推断，可选）",
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
	culturalContext?: string;
	authorRelation?: string;
	stance?: string;
	blindSpot?: string;
}

export async function handleSaveDraft(
	tmpDir: string,
	input: CreatePersonaInput,
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
	input: CreatePersonaInput,
): Promise<ToolResult> {
	let draft: any = null;
	if (input.sessionId) {
		try {
			draft = await handleSaveDraft(tmpDir, input);
		} catch (err) {
			return {
				content: [
					{ type: "text", text: `❌ 读取草稿失败：${String(err)}` },
				],
				isError: true,
			};
		}

		if (
			!draft ||
			!draft.fields ||
			!draft.fields.ageRange ||
			!draft.fields.interests ||
			!draft.fields.traits ||
			!draft.fields.platform
		) {
			return {
				content: [
					{
						type: "text",
						text: `❌ 创建失败：未找到完整的临时草稿。你必须扮演角色构建引擎，先使用 update_persona_draft 逐步收集并保存角色的【年龄段(ageRange)、兴趣方向(interests)、性格特质(traits)、常用平台(platform)】，确认无误后才能调用 create_persona 完成创建。`,
					},
				],
				isError: true,
			};
		}
	}

	const id =
		input.id ||
		input.name.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase() ||
		`persona_${Math.random().toString(36).substring(2, 8)}`;

	// Dynamically infer description and tags from draft fields if not provided
	let description = input.description;
	if (
		!description &&
		draft &&
		draft.fields &&
		Array.isArray(draft.fields.traits)
	) {
		description = `一个主要活跃在【${draft.fields.platform || ""}】平台，兴趣在于【${Array.isArray(draft.fields.interests) ? draft.fields.interests.join("、") : ""}】，性格特质为【${draft.fields.traits.join("，")}】的评论员角色。`;
	}
	if (!description) {
		description = "由模型推断自动生成的角色";
	}

	let tags = input.tags;
	if (!tags && draft && draft.fields) {
		tags = [];
		if (draft.fields.platform) tags.push(draft.fields.platform);
		if (Array.isArray(draft.fields.interests))
			tags.push(...draft.fields.interests);
	}
	if (!tags) {
		tags = [];
	}

	if (!/^[a-z0-9_]+$/.test(id)) {
		return {
			content: [
				{
					type: "text",
					text: `❌ 名称格式不合法，只能包含小写英文字母、数字 and 下划线。`,
				},
			],
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
			content: [
				{
					type: "text",
					text: `⚠️ 这个评论员名称已存在。请换个名称，或先删除旧的再创建。`,
				},
			],
			isError: true,
		};
	}

	const meta: PersonaMeta = {
		id,
		name: input.name,
		name_en: input.name_en ?? "",
		version: "1.0.0",
		author: input.author ?? "ai-generated",
		tags: tags,
		description,
		culturalContext: input.culturalContext || "未提供",
		authorRelation: input.authorRelation || "未提供",
		stance: input.stance || "未提供",
		blindSpot: input.blindSpot || "无特定盲区",
	};

	let personaDescription = "";
	if (draft && draft.fields) {
		personaDescription += `年龄段：${draft.fields.ageRange || ""}\n`;
		personaDescription += `兴趣方向：${Array.isArray(draft.fields.interests) ? draft.fields.interests.join("、") : draft.fields.interests || ""}\n`;
		personaDescription += `常用平台：${draft.fields.platform || ""}\n`;
		personaDescription += `性格特质：\n`;
		if (Array.isArray(draft.fields.traits)) {
			draft.fields.traits.forEach(
				(t: string) => (personaDescription += `- ${t}\n`),
			);
		}

		const cultural =
			input.culturalContext ||
			(draft.fields && draft.fields.culturalContext) ||
			"未提供";
		const relation =
			input.authorRelation ||
			(draft.fields && draft.fields.authorRelation) ||
			"未提供";
		const stanceVal =
			input.stance || (draft.fields && draft.fields.stance) || "未提供";
		const blind =
			input.blindSpot ||
			(draft.fields && draft.fields.blindSpot) ||
			"无特定盲区";

		personaDescription += `文化背景：${cultural}\n`;
		personaDescription += `与作者的关系：${relation}\n`;
		personaDescription += `立场：${stanceVal}\n`;
		personaDescription += `盲区：${blind}\n`;
	} else {
		personaDescription = description;

		const cultural = input.culturalContext || "未提供";
		const relation = input.authorRelation || "未提供";
		const stanceVal = input.stance || "未提供";
		const blind = input.blindSpot || "无特定盲区";

		personaDescription += `\n文化背景：${cultural}\n`;
		personaDescription += `与作者的关系：${relation}\n`;
		personaDescription += `立场：${stanceVal}\n`;
		personaDescription += `盲区：${blind}\n`;
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
					"现在即可在评测中选择使用这个评论员。",
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
	input: UpdatePersonaDraftInput,
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
			content: [
				{ type: "text", text: `❌ 读取草稿文件失败: ${String(err)}` },
			],
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
		await fs.promises.writeFile(
			filePath,
			JSON.stringify(draft, null, 2),
			"utf-8",
		);
	} catch (err) {
		return {
			content: [
				{ type: "text", text: `❌ 写入草稿文件失败: ${String(err)}` },
			],
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
	input: DeletePersonaDraftInput,
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
			content: [
				{ type: "text", text: `❌ 读取或校验草稿文件失败: ${String(err)}` },
			],
			isError: true,
		};
	}

	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		return {
			content: [
				{ type: "text", text: `❌ 删除草稿文件失败: ${String(err)}` },
			],
			isError: true,
		};
	}

	return {
		content: [{ type: "text", text: `✅ 草稿删除成功` }],
	};
}
