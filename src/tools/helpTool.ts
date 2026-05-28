import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../utils/types.js";
import type { ToolModule } from "./types.js";
import { getToolDescription, getHelpText } from "../i18n/tools-i18n.js";

export const helpToolDefinition: Tool = {
  name: "kevlar_help",
  description: getToolDescription("help"),
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

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
        text: getHelpText(),
      },
    ],
  };
}
