import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MultiTurnSamplingFunction } from "../execution/base.js";
import type { WebSearchFunction } from "../execution/webSearch.js";

export type ToolHandler = (args: Record<string, unknown> | undefined) => Promise<any>;

export interface ToolDependencies {
  skillsDir: string;
  tmpDir: string;
  /** Resolve sampling capability. Returns undefined when unsupported. */
  resolveSamplingFn: () => MultiTurnSamplingFunction | undefined;
  /** Resolve web search capability. Returns undefined when unsupported. */
  resolveWebSearchFn: () => WebSearchFunction | undefined;
}

export interface ToolModule {
  definition: Tool;
  handler: (deps: ToolDependencies) => ToolHandler;
}
