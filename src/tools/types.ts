import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MultiTurnSamplingFunction } from "../execution/base.js";
import type { StrategyProvider } from "../execution/strategy.js";

export type ToolHandler = (args: Record<string, unknown> | undefined) => Promise<any>;

export interface ToolDependencies {
  skillsDir: string;
  tmpDir: string;
  /** Resolve sampling capability. Returns undefined when unsupported. */
  resolveSamplingFn: () => MultiTurnSamplingFunction | undefined;
  /**
   * Fire-and-forget progress notification to MCP client (via logging notification).
   * Used to surface "审计进行中" hints without blocking execution.
   */
  sendProgress?: (message: string) => void;
  /** Strategy provider for Free/Pro plan resolution. */
  strategyProvider: StrategyProvider;
}

export interface ToolModule {
  definition: Tool;
  handler: (deps: ToolDependencies) => ToolHandler;
}
