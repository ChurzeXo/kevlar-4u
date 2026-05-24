import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MultiTurnSamplingFunction } from "../execution/base.js";

export type ToolHandler = (args: Record<string, unknown> | undefined) => Promise<any>;

export interface ToolDependencies {
  skillsDir: string;
  tmpDir: string;
  createMultiTurnSamplingFn: () => MultiTurnSamplingFunction;
  updateClientSamplingSupport: () => boolean;
}

export interface ToolModule {
  definition: Tool;
  handler: (deps: ToolDependencies) => ToolHandler;
}
