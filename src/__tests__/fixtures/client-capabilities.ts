/**
 * Canonical MCP client capability declarations for testing.
 *
 * Per docs/audit-hybrid-execution.md §能力声明前提 (lines 73-86),
 * Kevlar recognizes three sampling-related capability levels plus
 * an independent task cancel capability.
 *
 * Capability declarations follow MCP spec 2025-11-25 initialize response format.
 */

/** Level 2: Serial MCP sampling — client supports synchronous sampling/createMessage. */
export const CAP_SAMPLING_SERIAL = {
  sampling: {},
} as const;

/** Level 1: Task-augmented sampling — true parallel execution with task lifecycle. */
export const CAP_SAMPLING_TASK_AUGMENTED = {
  sampling: {},
  tasks: {
    requests: {
      sampling: { createMessage: {} },
    },
  },
} as const;

/** Independent capability: task cancellation. Per spec, MUST NOT call tasks/cancel
 *  if receiver did not declare this capability. */
export const CAP_TASKS_CANCEL = {
  tasks: {
    cancel: {},
  },
} as const;

/** Full MCP client: serial sampling + task-augmented + cancel. Matches the realistic
 *  client payload from the audit document. */
export const CAP_FULL_CLIENT = {
  sampling: {},
  tasks: {
    requests: {
      sampling: { createMessage: {} },
    },
    cancel: {},
  },
  experimental: {
    "kevlar.host.execution/v1": {
      version: "1.0.0",
      ephemeralAgents: { supported: true },
      orchestration: { supported: true },
    },
  },
} as const;

/** No capabilities declared. Should fall through to host_orchestration/standard. */
export const CAP_NONE = {} as const;
