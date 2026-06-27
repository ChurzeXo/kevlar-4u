import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// Lightweight definitions only — no handler code, no heavy imports.
// This file is loaded at server startup for ListTools. Handlers are lazy-loaded.
export const TOOL_DEFINITIONS: Record<string, Tool> = {
  list_personas: {
    name: "list_personas",
    description: "View existing reviewer list.",
    inputSchema: {
      type: "object" as const,
      properties: {
        platform: {
          type: "string",
          description: "Platform name (e.g., 'Xiaohongshu', 'Zhihu'). No param → overview by platform; with platform name → list for that platform; 'all' → list all.",
        },
      },
      required: [],
    },
  },

  create_persona_wizard: {
    name: "create_persona_wizard",
    description: "Create new reviewer through interactive wizard. First call without sessionId, tool guides user through information collection step by step.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session identifier for the persona creation wizard. Leave empty on first call; tool generates and returns a sessionId. Must provide this value in subsequent calls to continue the session.",
        },
        userMessage: {
          type: "string",
          description: "User's reply content. On first call, pass the user's original message (e.g., 'Help me create a fashion reviewer'). On subsequent calls, pass the user's response to the previous step's question.",
        },
      },
      required: ["userMessage"],
    },
  },

  delete_persona: {
    name: "delete_persona",
    description:
      "删除一个已存在的评审员（评论区模拟器中的删除功能）。AI 会先列出所有评审员供用户选择，二次确认后执行删除。不能删除不存在的角色，不能撤销删除操作。必须先调 list_personas 获取可用列表供用户选择。",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "要删除的人设 ID。必须先通过 list_personas 获取目标人设的 ID。",
        },
        confirm: {
          type: "boolean",
          description: "二次确认标志，必须为 true 才会执行删除",
        },
      },
      required: ["id", "confirm"],
    },
  },

  delete_persona_wizard: {
    name: "delete_persona_wizard",
    description:
      "当用户说「删除/移除评审员/人设」时，调用此工具（评论区模拟器中的删除功能）。工具自动列出所有评审员供匹配，绑定目标后会要求用户回复完整人设名称以二次确认。用户未明确说出待删除角色名称时不会执行。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "删除向导的会话标识。首次调用请留空，工具会自动生成并返回一个 sessionId。后续调用必须传入此值以继续上一次的删除会话。",
        },
        userMessage: {
          type: "string",
          description: "用户在当前步骤的回复内容。首次调用时直接传入用户原话（例如「删除急性子路人甲」），工具自动匹配目标。后续步骤传入用户对工具提问的回复。",
        },
      },
      required: ["userMessage"],
    },
  },

  review_content_wizard: {
    name: "review_content_wizard",
    description:
      "内容风险评测向导工具。\n\n【核心功能】\n基于\"职业黑粉逆向解码\"视角，对用户提交的文本进行深度攻击链推演与多维度社会语义风险评测。\n\n【触发时机】\n当用户提交文本内容，并明确要求\"评测风险\"、\"审稿\"、\"挑刺\"、\"排查翻车风险\"或类似表述时调用。\n\n【接口契约】\n- 输入：待评测的纯文本（不支持图片、音频或文档附件）。\n- 输出：包含结构化数据（表格、分析链）与初步排版的风险检测报告 payload。\n\n【核心控制生命周期】\n1. 捕获输入：调用本工具，传入待评测文本。\n2. 搬运渲染：工具返回风险检测报告后，你作为外壳，必须严格按照工具返回的排版协议向用户展示最终报告，不得私自截断或增删。\n3. 状态冻结：展示完毕后，必须停留在当前状态，静默等待用户明确指令。绝对禁止私自、自动推进舆论仿真推演或目标平台风控模拟流程。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "会话ID。首次调用时留空（工具会自动生成并返回）。后续调用必须传入相同 sessionId 以维持会话状态。",
        },
        userMessage: {
          type: "string",
          description: "用户当前输入内容。首次调用时传入待评测的完整文本或评测请求；后续交互时传入用户指令（如「开始舆论仿真推演」或「2 换一位」）。必须为纯文本。",
        },
      },
      required: ["userMessage"],
    },
  },

  review_content_wizard_continue: {
    name: "review_content_wizard_continue",
    description:
      "提交宿主编排执行结果并继续审计流程。" +
      "与 review_content_wizard 不同，此工具使用 session checkpoint + revision 协议确保结果一致性，" +
      "防止旧回合覆盖新状态。当 Kevlar 返回 continuation contract 时，必须使用此工具提交结果。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Kevlar 返回的会话 ID（来自延续合同）",
        },
        checkpoint: {
          type: "string",
          description: "当前检查点（如 step0_completed、preaudit_completed）",
          enum: [
            "initiated",
            "step0_completed",
            "preaudit_started",
            "preaudit_completed",
            "persona_inventory_completed",
            "persona_audit_started",
          ],
        },
        expectedRevision: {
          type: "number",
          description: "会话的预期版本号。Kevlar 返回 continuation contract 时提供。",
        },
        continuationId: {
          type: "string",
          description: "延续 ID。Kevlar 返回 continuation contract 时提供。",
        },
        result: {
          type: "string",
          description: "执行结果。可以是 JSON 结构或自然语言文本。",
        },
        receipt: {
          type: "object",
          description: "符合 kevlar.exec/v1 协议的 ExecutionReceipt 结构体",
        },
      },
      required: ["sessionId", "checkpoint", "expectedRevision", "continuationId"],
    },
  },

  kevlar_help: {
    name: "kevlar_help",
    description: "Display complete usage help including feature descriptions, available tools, and FAQs.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },

  get_execution_modes: {
    name: "get_execution_modes",
    description: "当用户问「当前模式/配置/可用模式」时，调用此工具。查询宿主辅助兜底、Subagent 并行调度等执行模式的可用性及当前配置状态。",
    inputSchema: { type: "object" as const, properties: {} },
  },

  configure: {
    name: "configure",
    description:
      "直接修改 Kevlar-4u 运行配置（执行模式、并发数等），改动即时写入 kevlar-config.json。" +
      "无需对话确认，适合明确的单次配置变更场景。" +
      "如需先预览再写入，请使用 configure_wizard。",
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string",
          enum: ["auto", "orchestration", "mcp_subagent"],
          description: "执行模式。不传则不修改当前值。",
        },
        maxConcurrency: {
          type: "number",
          minimum: 1,
          maximum: 10,
          description: "最大并发数（仅 mcp_subagent 模式生效）。不传则不修改。",
        },
      },
    },
  },

  configure_wizard: {
    name: "configure_wizard",
    description:
      "当用户说「设置/配置/切换模式/改并发数」时，调用此工具。工具先预览配置变更，用户确认后才写入 kevlar-config.json。API Key 不由此工具处理，只能通过环境变量设置。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "配置向导的会话标识。首次调用请留空，工具会自动生成并返回一个 sessionId。后续调用必须传入此值以继续上一次的配置会话。",
        },
        userMessage: {
          type: "string",
          description: "用户在当前步骤的回复内容。首次调用时传入用户原话（例如「切换到 MCP 采样模式」「并发数改成 5」），工具解析变更项并预览。后续步骤传入用户对工具提问的回复。",
        },
      },
      required: ["userMessage"],
    },
  },

  set_language: {
    name: "set_language",
    description: "Switch interface language. Supports Chinese (zh-CN) and English (en-US).",
    inputSchema: {
      type: "object" as const,
      properties: {
        language: {
          type: "string",
          description: "Language code: 'zh-CN' for Chinese, 'en-US' for English",
          enum: ["zh-CN", "en-US"],
        },
      },
      required: ["language"],
    },
  },

  check_update: {
    name: "check_update",
    description: "检查 kevlar-4u 是否有新版本可用。对比服务端最新版本号，如有更新告知升级命令。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
};
