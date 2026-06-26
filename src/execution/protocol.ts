/**
 * Kevlar Execution Protocol v1 (Final Unified Spec)
 *
 * Implements AgentBlueprint, ExecutionReceipt, and AggregationValidation schemas,
 * along with the validation gates and continuation guard optimistic lock checks.
 */

import { resumeFromStructuredFailure } from "./checkpoint.js";

// ── 3.1 Agent Blueprint ──────────────────────────────────────────────────────

export interface AgentBlueprint {
  protocol: "kevlar.exec/v1";

  execution: {
    mode: "ephemeral_agents";
    allowedModes: ("native_subagent" | "simulated_agent")[];
    concurrency: number;
    isolation: {
      required: boolean;
      level: "strict" | "best_effort";
    };
  };

  agents: AgentDefinition[];
  aggregation: AggregationSpec;
  continuation: ContinuationSpec;
}

export interface AgentDefinition {
  id: string; // Globally unique tracking ID
  role: "safety_reviewer" | "policy_reviewer" | "context_reviewer" | string;
  instructions: string; // Focused domain instructions
  input: {
    contentRef: string; // Pointer to content
    policyRef?: string;
  };
  outputSchema: "kevlar.reviewer/v1"; // Individual reviewer schema
}

export interface AggregationSpec {
  strategy: "host_merge";
  rules: {
    requireAllAgents: boolean;
    conflictResolution: "host_decide" | "majority_vote" | "risk_maximization";
    outputSchema: "kevlar.audit/v1"; // Final aggregated report schema
  };
}

export interface ContinuationSpec {
  tool: "review_content_wizard_continue";
  sessionId: string;
  checkpoint: string;
  expectedRevision: number;
  idempotencyKey?: string;
}

// ── 3.2 Execution Receipt ────────────────────────────────────────────────────

export interface ExecutionReceipt {
  protocol: "kevlar.exec/v1";

  execution: {
    requestedMode: "ephemeral_agents";
    actualMode:
      | "native_subagent"
      | "simulated_agent"
      | "orchestration_fallback";

    requestedConcurrency: number;
    actualConcurrency: number;

    contextIsolation: {
      requested: boolean;
      achieved: boolean | "unknown";
    };

    parallelism: "parallel" | "sequential" | "unknown";

    evidenceLevel: "host_attested" | "best_effort" | "unknown";
  };

  agents: AgentExecutionResult[];
  aggregation?: any;
}

export interface AgentExecutionResult {
  id: string;
  role: string;
  status: "completed" | "failed";
  output: unknown;
  latencyMs?: number;
  tokenUsage?: number;
}

// ── 3.3 Aggregation Validation ───────────────────────────────────────────────

export interface AggregationValidation {
  protocol: "kevlar.exec/v1";

  status:
    | "valid"          // Perfectly compliant, advance state machine
    | "partial"        // Some agents failed, but critical dimensions intact, downgrade accept
    | "invalid"        // Protocol broken or format error, reject and fallback to standard orchestration
    | "fallback_used"; // Host auto-degraded, but schema is intact, accepted

  checks: {
    schemaValid: boolean;           // output matches outputSchema
    allAgentsPresent: boolean;      // receipt agents count & IDs match blueprint
    aggregationConsistent: boolean; // aggregation matches outputSchema and doesn't conflict
    executionMismatch?: boolean;    // requestedMode !== actualMode
    isolationViolation?: boolean;   // isolation.required but achieved is false
  };

  risk: {
    level: "low" | "medium" | "high" | "unknown";
    reasons: string[];
  };
}

// ── 4. Validation Gates ──────────────────────────────────────────────────────

/**
 * Runs strong-typed post-execution cross-validation on an ExecutionReceipt.
 */
export function runAggregationValidation(
  receipt: any,
  blueprint?: AgentBlueprint
): AggregationValidation {
  const checks = {
    schemaValid: false,
    allAgentsPresent: false,
    aggregationConsistent: false,
    executionMismatch: false,
    isolationViolation: false,
  };

  const risk = {
    level: "unknown" as "low" | "medium" | "high" | "unknown",
    reasons: [] as string[],
  };

  if (!receipt || typeof receipt !== "object") {
    risk.reasons.push("Execution receipt is missing or not a valid object");
    return {
      protocol: "kevlar.exec/v1",
      status: "invalid",
      checks,
      risk,
    };
  }

  if (receipt.protocol !== "kevlar.exec/v1") {
    risk.reasons.push(`Protocol mismatch: expected 'kevlar.exec/v1', got '${receipt.protocol}'`);
  }

  // 1. Schema 一致性断言
  let schemaValid = true;
  if (!Array.isArray(receipt.agents)) {
    schemaValid = false;
    risk.reasons.push("receipt.agents must be an array");
  } else {
    for (const agent of receipt.agents) {
      if (!agent || typeof agent !== "object" || !agent.id || !agent.status) {
        schemaValid = false;
        risk.reasons.push(`Agent result has invalid structure: ${JSON.stringify(agent)}`);
        continue;
      }
      if (agent.status === "completed") {
        if (!agent.output || typeof agent.output !== "object") {
          schemaValid = false;
          risk.reasons.push(`Agent '${agent.id}' output is missing or not an object`);
        } else {
          const output = agent.output;
          if (!Array.isArray(output.findings)) {
            schemaValid = false;
            risk.reasons.push(`Agent '${agent.id}' output.findings must be an array`);
          }
        }
      }
    }
  }

  // Check final aggregated report
  const aggregation = receipt.aggregation || receipt.output || (receipt.dimensions ? receipt : null);
  if (!aggregation || typeof aggregation !== "object") {
    schemaValid = false;
    risk.reasons.push("Aggregation report (kevlar.audit/v1) is missing in receipt");
  } else {
    if (!Array.isArray(aggregation.dimensions)) {
      schemaValid = false;
      risk.reasons.push("Aggregation dimensions must be an array");
    }
    if (typeof aggregation.summary !== "string") {
      schemaValid = false;
      risk.reasons.push("Aggregation summary must be a string");
    }
  }
  checks.schemaValid = schemaValid;

  // 2. 智能体数量对齐
  let allAgentsPresent = true;
  if (blueprint && blueprint.agents && Array.isArray(blueprint.agents)) {
    if (!receipt.agents || receipt.agents.length !== blueprint.agents.length) {
      allAgentsPresent = false;
      risk.reasons.push(`Agent count mismatch: expected ${blueprint.agents.length}, got ${receipt.agents?.length || 0}`);
    } else {
      const blueprintIds = new Set(blueprint.agents.map((a: any) => a.id));
      for (const agent of receipt.agents) {
        if (!blueprintIds.has(agent.id)) {
          allAgentsPresent = false;
          risk.reasons.push(`Unexpected agent id in receipt: '${agent.id}'`);
        }
      }
    }
  } else {
    allAgentsPresent = Array.isArray(receipt.agents) && receipt.agents.length > 0;
  }
  checks.allAgentsPresent = allAgentsPresent;

  // 3. 聚合一致性检查
  let aggregationConsistent = true;
  if (schemaValid && aggregation) {
    const agentIds = new Set((receipt.agents || []).map((a: any) => a.id));
    const dimIds = new Set((aggregation.dimensions || []).map((d: any) => d.id));
    for (const id of agentIds) {
      if (!dimIds.has(id)) {
        aggregationConsistent = false;
        risk.reasons.push(`Aggregation is missing dimension for agent '${id}'`);
      }
    }
  }
  checks.aggregationConsistent = aggregationConsistent;

  // 4. 自适应分流兼容性
  const requestedMode = blueprint?.execution?.mode || "ephemeral_agents";
  const actualMode = receipt.execution?.actualMode || "orchestration_fallback";
  const executionMismatch = requestedMode !== "ephemeral_agents" || (actualMode !== "native_subagent" && actualMode !== "simulated_agent");
  checks.executionMismatch = executionMismatch;

  // 5. 隔离安全惩罚
  const requestedIsolation = blueprint?.execution?.isolation?.required ?? true;
  const achievedIsolation = receipt.execution?.contextIsolation?.achieved;
  const isolationViolation = requestedIsolation && (achievedIsolation === false);
  checks.isolationViolation = isolationViolation;

  // Determine overall status
  let status: AggregationValidation["status"] = "valid";
  if (!schemaValid || !allAgentsPresent) {
    status = "invalid";
  } else if (executionMismatch) {
    status = "fallback_used";
  } else if (receipt.agents.some((a: any) => a.status === "failed")) {
    status = "partial";
  }

  // Determine risk level based on findings
  let highestLevel: "low" | "medium" | "high" | "unknown" = "low";
  if (schemaValid) {
    for (const agent of receipt.agents) {
      if (agent.status === "completed" && agent.output && Array.isArray(agent.output.findings)) {
        for (const finding of agent.output.findings) {
          const lvl = finding.suggestedLevel || finding.level;
          if (lvl === "🔴" || lvl === "high") {
            highestLevel = "high";
          } else if ((lvl === "🟡" || lvl === "medium") && highestLevel !== "high") {
            highestLevel = "medium";
          }
        }
      }
    }
    if (aggregation && Array.isArray(aggregation.dimensions)) {
      for (const dim of aggregation.dimensions) {
        const lvl = dim.level;
        if (lvl === "🔴" || lvl === "high") {
          highestLevel = "high";
        } else if ((lvl === "🟡" || lvl === "medium") && highestLevel !== "high") {
          highestLevel = "medium";
        }
      }
    }
  }

  if (isolationViolation) {
    if (highestLevel === "low") highestLevel = "medium";
    else if (highestLevel === "medium") highestLevel = "high";
    risk.reasons.push("Isolation safety violation: risk level escalated");
  }

  risk.level = highestLevel;

  return {
    protocol: "kevlar.exec/v1",
    status,
    checks,
    risk,
  };
}

// ── 5. Continuation Guard ───────────────────────────────────────────────────

export function validateContinuationGate(
  currentState: any,
  submission: {
    continuationId: string;
    expectedRevision: number;
    receipt: any;
  }
): AggregationValidation {
  // 1. 基础物理拦截：锁机制与生命周期对齐
  if (currentState.revision !== submission.expectedRevision) {
    throw new Error("stale_continuation_revision_locked");
  }
  if (!currentState.activeContinuation || currentState.activeContinuation.continuationId !== submission.continuationId) {
    throw new Error("continuation_id_mismatch");
  }

  // 2. 核心协议审判：执行协议闭环一致性检查
  const validationResult = runAggregationValidation(submission.receipt, currentState.blueprint);

  if (validationResult.status === "invalid") {
    // 格式损坏、或发生不可逆的协议不匹配，清理 structured 残留，
    // 安全地将协作策略下调至标准宿主单体编排 (Standard Orchestration)
    fallbackToStandardOrchestration(currentState, "schema_mismatch");
  }

  return validationResult;
}

export function fallbackToStandardOrchestration(state: any, reason: string) {
  const degraded = resumeFromStructuredFailure(state, reason as any);
  state.executionPlan = degraded.executionPlan;
  state.checkpoint = degraded.checkpoint;
  state.structuredDowngraded = degraded.structuredDowngraded;
  state.capabilityStatus = degraded.capabilityStatus;
  state.executionTransitions = degraded.executionTransitions;
  state.mode = "orchestration";

  if (state.orchestrationPreAuditContext && state.orchestrationPreAuditContext.step0Result) {
    state.step = "waitingForOrchestrationAudit";
    state.activeContinuation = {
      continuationId: `${state.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      checkpoint: "preaudit_started",
      expiresAt: Date.now() + 30 * 60 * 1000,
    };
  } else {
    state.step = "waitingForOrchestrationStep0";
    state.activeContinuation = {
      continuationId: `${state.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      checkpoint: "step0_completed",
      expiresAt: Date.now() + 30 * 60 * 1000,
    };
  }
  state.revision = (state.revision ?? 0) + 1;
}
