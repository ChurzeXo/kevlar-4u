/**
 * Subagent dispatch execution mode (mcp_subagent)
 *
 * Instructs the host AI to spawn subagents for parallel execution
 * of system audit dimensions. This provides true isolation and
 * parallelism, unlike the role-playing orchestration mode.
 *
 * Priority: 15 (between mcp_sampling(10) and direct_api(20))
 */

import type { ExecutionContext, ExecutionHandler, ExecutionResult, ExecutionMode } from "../base.js";
import { isSubagentDispatchSupported } from "../client.js";
import { buildSubagentDispatchPrompt } from "../../prompts/reviewWizard.js";

const MODE: ExecutionMode = "mcp_subagent";

/**
 * Subagent dispatch handler
 *
 * Returns a dispatch prompt that instructs the host AI to spawn
 * subagents for parallel system audit. The host AI is responsible
 * for executing the subagents and returning the aggregated result.
 */
export const subagentHandler: ExecutionHandler = {
  mode: MODE,
  priority: 15,

  canExecute(): boolean {
    return isSubagentDispatchSupported();
  },

  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    // This handler doesn't execute the review itself.
    // Instead, it returns a prompt that instructs the host AI
    // to spawn subagents for parallel execution.
    //
    // The actual execution happens in reviewContentWizardTool.ts,
    // where the wizard state machine handles the multi-turn interaction.

    // For now, return a placeholder result.
    // The actual dispatch prompt is built in reviewContentWizardTool.ts
    // when the wizard state machine enters the subagent dispatch step.

    throw new Error(
      "mcp_subagent mode must be invoked via reviewContentWizardTool state machine. " +
      "Direct execution is not supported."
    );
  },
};

/**
 * Build the subagent dispatch prompt for the wizard state machine
 *
 * This function is called from reviewContentWizardTool.ts when the
 * state machine determines that subagent dispatch should be used.
 */
export function buildSubagentDispatchPromptForWizard(params: {
  content: string;
  bareText: string;
  step0Result: any;
  webContextMap: Record<string, string>;
  auditors: any[];
  localFindings?: any[];
  timingContext?: string;
}): string {
  return buildSubagentDispatchPrompt(params);
}
