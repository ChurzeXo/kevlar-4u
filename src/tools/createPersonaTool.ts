import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs";
import type { ToolModule } from "./types.js";
import {
	validateWritePath,
	writePersonaFile,
	PersonaMeta,
} from "../utils/parser.js";
import { ToolResult } from "../utils/types.js";
import {
	extractShortTrait,
	mapTraitToKey,
	mapPlatformToKey,
	slugify,
} from "../utils/personaIdMaps.js";
import { getErrorInfo } from "../utils/observability.js";

// ── Description creation principles ─────────────────────────────────────────
// These norms govern the YAML `description` field for every persona:
//
//   1. LANGUAGE   — description uses the same language as the user's input
//   2. SCENARIO   — describe what the persona DOES with content, don't just
//                   dump collected fields
//   3. CONCRETE   — use specific behavioural details (e.g. "放大检查排版"),
//                   not abstract labels (e.g. "专业")
//   4. CONCISE    — one sentence, under 120 characters
//
// The template below is the baseline; when Sampling is available, the AI
// SHOULD regenerate a richer description that honours these same principles.
// ────────────────────────────────────────────────────────────────────────────
export const DESCRIPTION_PRINCIPLES = {
	LANGUAGE:
		"Use the same language as the user's input for the description",
	SCENARIO:
		"Describe the persona's content-consumption behaviour first; don't just list collected fields",
	CONCRETE:
		"Use specific, observable behaviours instead of abstract labels",
	CONCISE: "Single sentence, under 120 characters",
} as const;

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
				description: "字段值。标量字段传 string（ageRange、platform、authorRelation），列表字段传 string[]（interests、traits）",
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
		"根据草稿或直接参数创建并保存一个新的批评人设。当用户已完成 create_persona_wizard 的流程后调用此工具完成最终创建；也可直接传入 name 和各字段一步创建。[只写] 不负责收集用户偏好或引导对话——收集阶段应使用 create_persona_wizard。name 为必填，其余字段均可选。",
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
				description: "文化背景描述（可选），例如：日本二次元文化圈、一线城市职场文化。传空字符串则由草稿或系统推断。",
			},
			authorRelation: {
				type: "string",
				description: "该人设与内容作者的关系（可选），例如：路人、粉丝、同行。传空字符串则由草稿或系统推断。",
			},
			stance: {
				type: "string",
				description: "评论立场倾向（可选），例如：默认质疑、温和包容、技术导向。传空字符串则由草稿或系统推断。",
			},
			blindSpot: {
				type: "string",
				description: "认知盲区描述（可选），例如：对价格不敏感、忽略小众需求。传空字符串则由草稿或系统推断。",
			},
			gender: {
				type: "string",
				description: "性别（可选），可选值：男 / 女 / 未指定",
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
	gender?: string;
}

export const updatePersonaDraftModule: ToolModule = {
  definition: updatePersonaDraftToolDefinition,
  handler: (deps) => async (args) => {
    if (!args) throw new Error("需要提供参数");
    return await handleUpdatePersonaDraft(deps.tmpDir, args as any);
  },
};

export const deletePersonaDraftModule: ToolModule = {
  definition: deletePersonaDraftToolDefinition,
  handler: (deps) => async (args) => {
    if (!args) throw new Error("需要提供参数");
    return await handleDeletePersonaDraft(deps.tmpDir, args as any);
  },
};

export const createPersonaModule: ToolModule = {
  definition: createPersonaToolDefinition,
  handler: (deps) => async (args) => {
    if (!args) throw new Error("创建评论员需要提供参数");
    return await handleCreatePersona(deps.skillsDir, deps.tmpDir, args as any);
  },
};

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
			const info = getErrorInfo(err);
			return {
				content: [
					{ type: "text", text: `❌ 读取草稿失败：${info.message}` },
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
			!draft.fields.platform ||
			!draft.fields.authorRelation
		) {
			return {
				content: [
					{
						type: "text",
						text: `❌ 创建失败：未找到完整的临时草稿。你必须扮演角色构建引擎，先使用 update_persona_draft 逐步收集并保存角色的【年龄段(ageRange)、兴趣方向(interests)、性格特质(traits)、常用平台(platform)、与作者关系(authorRelation)】，确认无误后才能调用 create_persona 完成创建。`,
					},
				],
				isError: true,
			};
		}
	}

	const subDir = !input.id ? getSubDirFromDraft(draft) : undefined;

	const baseId =
		input.id ||
		generateIdFromDraft(draft) ||
		input.name.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase() ||
		`persona_${Math.random().toString(36).substring(2, 8)}`;

	const id = input.id ? baseId : applyDedup(skillsDir, baseId, subDir);

	if (!/^[a-z0-9_]+$/.test(id)) {
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

	// ── Description (see DESCRIPTION_PRINCIPLES above) ──
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
		gender: input.gender || "未指定",
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
		const gender =
			input.gender ||
			(draft.fields && draft.fields.gender) ||
			"未指定";

		personaDescription += `文化背景：${cultural}\n`;
		personaDescription += `与作者的关系：${relation}\n`;
		personaDescription += `立场：${stanceVal}\n`;
		personaDescription += `盲区：${blind}\n`;
		personaDescription += `性别：${gender}\n`;
	} else {
		personaDescription = description;

		const cultural = input.culturalContext || "未提供";
		const relation = input.authorRelation || "未提供";
		const stanceVal = input.stance || "未提供";
		const blind = input.blindSpot || "无特定盲区";
		const gender = input.gender || "未指定";

		personaDescription += `\n文化背景：${cultural}\n`;
		personaDescription += `与作者的关系：${relation}\n`;
		personaDescription += `立场：${stanceVal}\n`;
		personaDescription += `盲区：${blind}\n`;
		personaDescription += `性别：${gender}\n`;
	}

	try {
		await writePersonaFile(skillsDir, meta, personaDescription, subDir);
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

export function generateIdFromDraft(draft: any): string | undefined {
	if (!draft?.fields) return undefined;
	const traits = draft.fields.traits;
	const platform = draft.fields.platform || "";

	let traitShort = "";
	if (Array.isArray(traits) && traits.length > 0) {
		traitShort = extractShortTrait(traits[0]);
	}

	const traitKey = mapTraitToKey(traitShort) || slugify(traitShort);
	const platformKey = mapPlatformToKey(platform) || slugify(platform);

	if (!traitKey && !platformKey) return undefined;
	if (!traitKey) return platformKey;
	if (!platformKey) return traitKey;
	return `${traitKey}_${platformKey}`;
}

export function getSubDirFromDraft(draft: any): string | undefined {
	if (!draft?.fields) return undefined;
	const platform = draft.fields.platform || "";
	const platformKey = mapPlatformToKey(platform) || slugify(platform);
	return platformKey || undefined;
}

export function applyDedup(skillsDir: string, baseId: string, subDir?: string): string {
	let id = baseId;
	let counter = 1;
	const dir = subDir ? path.join(skillsDir, subDir) : skillsDir;
	while (fs.existsSync(path.join(dir, `${id}.md`))) {
		id = `${baseId}_${counter++}`;
	}
	return id;
}

export interface UpdatePersonaDraftInput {
	sessionId: string;
	field: "ageRange" | "interests" | "traits" | "platform" | "authorRelation";
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
		const info = getErrorInfo(err);
		return {
			content: [
				{ type: "text", text: `❌ 读取草稿文件失败: ${info.message}` },
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
		authorRelation: 5,
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
		const info = getErrorInfo(err);
		return {
			content: [
				{ type: "text", text: `❌ 写入草稿文件失败: ${info.message}` },
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
		const info = getErrorInfo(err);
		return {
			content: [
				{ type: "text", text: `❌ 读取或校验草稿文件失败: ${info.message}` },
			],
			isError: true,
		};
	}

	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		const info = getErrorInfo(err);
		return {
			content: [
				{ type: "text", text: `❌ 删除草稿文件失败: ${info.message}` },
			],
			isError: true,
		};
	}

	return {
		content: [{ type: "text", text: `✅ 草稿删除成功` }],
	};
}
