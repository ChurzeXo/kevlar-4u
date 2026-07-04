/**
 * Kevlar Execution Protocol v1 (Final Unified Spec)
 *
 * Implements ExecutionBlueprint, ExecutionReceipt, and AggregationValidation schemas,
 * along with the validation gates and continuation guard optimistic lock checks.
 */

import { resumeFromStructuredFailure } from "./checkpoint.js";
import { logger } from "../utils/logger.js";
import { normalizeRiskLevel } from "./riskLevel.js";
import { validationError } from "../utils/errors.js";

// ── 3.1 Execution Blueprint ──────────────────────────────────────────────────────

export interface ExecutionBlueprint {
  protocol: "kevlar.blueprint/v1";

  execution: {
    mode: "isolated_contexts";
    allowedModes: ("native_subagent" | "simulated_agent")[];
    concurrency: number;
    isolation: {
      required: boolean;
      level: "strict" | "best_effort";
    };
  };

  contexts: ContextDefinition[];
  aggregation: AggregationSpec;
  continuation: ContinuationSpec;
}

export interface ContextDefinition {
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
    requireAllContexts: boolean;
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
  // Pro: slot-based per-agent result submission metadata
  contextSlots?: {
    total: number;
    contextIds: string[];
    allowPartialSubmit: true;
  };
}

/**
 * Single agent result submitted independently via slot-based protocol.
 * Used when ContinuationSpec.contextSlots is present.
 */
export interface ContextSlotResult {
  contextId: string;
  status: "completed" | "failed";
  submittedAt: number;
  output: {
    findings: Finding[];
    reasoning?: string;
  };
}

export interface Finding {
  id?: string;
  keyword?: string;
  level?: string;
  suggestedLevel?: string;
  description?: string;
  detail?: string;
  category?: string;
  location?: string;
  context?: string;
  suggestions?: string[];
  reason?: string;
  confident?: boolean;
  [key: string]: unknown;
}

// ── 3.2 Execution Receipt ────────────────────────────────────────────────────

/**
 * Aggregated audit report (kevlar.audit/v1).
 * Embedded in ExecutionReceipt.aggregation.
 */
export interface AggregationReport {
  dimensions: AggregationDimension[];
  summary: string;
}

export interface AggregationDimension {
  id: string;
  level: string;
  findings?: Finding[];
  [key: string]: unknown;
}

/**
 * Output structure expected from each agent.
 * Must be a JSON object containing a `findings` array.
 */
export interface ContextOutput {
  findings: Finding[];
  reasoning?: string;
  [key: string]: unknown;
}

export interface ExecutionReceipt {
  protocol: "kevlar.blueprint/v1";

  execution: {
    requestedMode: "isolated_contexts";
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

  contexts: ContextExecutionResult[];
  aggregation?: AggregationReport;
}

export interface ContextExecutionResult {
  id: string;
  role: string;
  status: "completed" | "failed";
  output: ContextOutput;
  latencyMs?: number;
  tokenUsage?: number;
}

// ── 3.3 Aggregation Validation ───────────────────────────────────────────────

export interface AggregationValidation {
  protocol: "kevlar.blueprint/v1";

  status:
    | "valid"          // Perfectly compliant, advance state machine
    | "partial"        // Some agents failed, but critical dimensions intact, downgrade accept
    | "invalid"        // Protocol broken or format error, reject and fallback to standard orchestration
    | "fallback_used"; // Host auto-degraded, but schema is intact, accepted

  checks: {
    schemaValid: boolean;           // output matches outputSchema
    allContextsPresent: boolean;      // receipt agents count & IDs match blueprint
    aggregationConsistent: boolean; // aggregation matches outputSchema and doesn't conflict
    executionMismatch?: boolean;    // requestedMode !== actualMode
    isolationViolation?: boolean;   // isolation.required but achieved is false
  };

  risk: {
    level: "low" | "medium" | "high" | "unknown";
    reasons: string[];
  };

  /** IDs of agents declared in the blueprint but missing from the receipt. */
  missingContextIds?: string[];
}

// ── 4. Validation Gates ──────────────────────────────────────────────────────

/**
 * Authoritative post-execution semantic validator for an ExecutionReceipt.
 *
 * This is the **primary validation function** to use after the host AI
 * completes its task-agent execution.  It runs 4 full validation gates:
 *
 *   Gate 1 — Schema consistency (agents have valid output.findings)
 *   Gate 2 — Context count alignment with blueprint
 *   Gate 3 — Aggregation consistency (dimensions match agents)
 *   Gate 4 — Execution mismatch + isolation safety violation detection
 *
 * Additionally, it determines overall status (`valid` / `partial` / `invalid` /
 * `fallback_used`) and escalates risk level for isolation violations.
 *
 * Use this function **post-execution**.  If you only need a lightweight
 * format/shape check (e.g. before the receipt is even dispatched), see
 * {@link validateReceipt} instead.
 */
export function runAggregationValidation(
  receipt: any,
  blueprint?: ExecutionBlueprint
): AggregationValidation {
  const checks = {
    schemaValid: false,
    allContextsPresent: false,
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
      protocol: "kevlar.blueprint/v1",
      status: "invalid",
      checks,
      risk,
    };
  }

  if (receipt.protocol !== "kevlar.blueprint/v1") {
    risk.reasons.push(`Protocol mismatch: expected 'kevlar.exec/v1', got '${receipt.protocol}'`);
  }

  // 1. Schema 一致性断言
  let schemaValid = true;
  if (!Array.isArray(receipt.contexts)) {
    schemaValid = false;
    risk.reasons.push("receipt.contexts must be an array");
  } else {
    for (const agent of receipt.contexts) {
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
  let allContextsPresent = true;
  const missingContextIds: string[] = [];
  if (blueprint && blueprint.contexts && Array.isArray(blueprint.contexts)) {
    const blueprintIds = new Set(blueprint.contexts.map((a: any) => a.id));
    const receiptIds = new Set((receipt.contexts || []).map((a: any) => a.id));

    // Detect missing agents (in blueprint but not in receipt)
    for (const id of blueprintIds) {
      if (!receiptIds.has(id)) {
        allContextsPresent = false;
        missingContextIds.push(id);
      }
    }

    // Detect unexpected agents (in receipt but not in blueprint)
    for (const id of receiptIds) {
      if (!blueprintIds.has(id)) {
        allContextsPresent = false;
        risk.reasons.push(`Unexpected agent id in receipt: '${id}'`);
      }
    }

    if (!receipt.contexts || receipt.contexts.length !== blueprint.contexts.length) {
      risk.reasons.push(
        `Context count mismatch: expected ${blueprint.contexts.length}, got ${receipt.contexts?.length || 0}`,
      );
    }
    if (missingContextIds.length > 0) {
      risk.reasons.push(`Missing agents: ${missingContextIds.join(", ")}`);
    }
  } else {
    allContextsPresent = Array.isArray(receipt.contexts) && receipt.contexts.length > 0;
  }
  checks.allContextsPresent = allContextsPresent;

  // 2b. actualConcurrency 检查 (§4.3)
  const expectedConcurrency = blueprint?.execution?.concurrency ?? (blueprint?.contexts?.length || 0);
  const actualConcurrency = receipt.execution?.actualConcurrency;
  const concurrencyMismatch =
    expectedConcurrency > 0 && typeof actualConcurrency === "number" && actualConcurrency !== expectedConcurrency;
  if (concurrencyMismatch) {
    checks.allContextsPresent = false; // treat concurrency gap as incomplete
    missingContextIds.push(...blueprint!.contexts!
      .filter((a: any) => !new Set((receipt.contexts || []).map((ra: any) => ra.id)).has(a.id))
      .map((a: any) => a.id));
    risk.reasons.push(
      `Concurrency mismatch: blueprint declares ${expectedConcurrency}, but receipt reports actualConcurrency=${actualConcurrency}`,
    );
  }

  // 3. 聚合一致性检查
  let aggregationConsistent = true;
  if (schemaValid && aggregation) {
    const contextIds = new Set((receipt.contexts || []).map((a: any) => a.id));
    const dimIds = new Set((aggregation.dimensions || []).map((d: any) => d.id));
    for (const id of contextIds) {
      if (!dimIds.has(id)) {
        aggregationConsistent = false;
        risk.reasons.push(`Aggregation is missing dimension for agent '${id}'`);
      }
    }
  }
  checks.aggregationConsistent = aggregationConsistent;

  // 4. 自适应分流兼容性：检测执行降级
  //    actualMode 为 "orchestration_fallback" 表示宿主未能执行 subagent，已降级为编排模式。
  //    native_subagent 和 simulated_agent 都是正常的 subagent 执行方式，不算降级。
  const actualExecMode = receipt.execution?.actualMode;
  const executionMismatch = actualExecMode === "orchestration_fallback";
  checks.executionMismatch = executionMismatch;

  // 5. 隔离安全惩罚
  const requestedIsolation = blueprint?.execution?.isolation?.required ?? true;
  const achievedIsolation = receipt.execution?.contextIsolation?.achieved;
  const isolationViolation = requestedIsolation && (achievedIsolation === false);
  checks.isolationViolation = isolationViolation;

  // Determine overall status
  let status: AggregationValidation["status"] = "valid";
  if (!schemaValid || !allContextsPresent) {
    status = "invalid";
  } else if (executionMismatch) {
    status = "fallback_used";
  } else if (receipt.contexts.some((a: any) => a.status === "failed")) {
    status = "partial";
  }

  // Determine risk level based on findings
  let highestLevel: "low" | "medium" | "high" | "unknown" = "low";
  if (schemaValid) {
    for (const agent of receipt.contexts) {
      if (agent.status === "completed" && agent.output && Array.isArray(agent.output.findings)) {
        for (const finding of agent.output.findings) {
          const normalized = normalizeRiskLevel(finding.suggestedLevel || finding.level);
          if (normalized === "🔴") {
            highestLevel = "high";
          } else if (normalized === "🟡" && highestLevel !== "high") {
            highestLevel = "medium";
          }
        }
      }
    }
    if (aggregation && Array.isArray(aggregation.dimensions)) {
      for (const dim of aggregation.dimensions) {
        const normalized = normalizeRiskLevel(dim.level);
        if (normalized === "🔴") {
          highestLevel = "high";
        } else if (normalized === "🟡" && highestLevel !== "high") {
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
    protocol: "kevlar.blueprint/v1",
    status,
    checks,
    risk,
    missingContextIds: missingContextIds.length > 0 ? missingContextIds : undefined,
  };
}

// ── 5. Continuation Guard ───────────────────────────────────────────────────

/** Maximum retries before auto-degrading the wizard. */
export const MAX_CONTINUATION_RETRIES = 3;

export function validateContinuationGate(
  currentState: any,
  submission: {
    continuationId: string;
    expectedRevision: number;
    receipt: any;
  }
): AggregationValidation {
  // 0. 输入格式校验（§7.1）
  const CONTINUATION_ID_RE = /^[a-z0-9-]+$/;
  if (typeof submission.continuationId !== "string" || !CONTINUATION_ID_RE.test(submission.continuationId)) {
    throw validationError("invalid_continuation_id_format");
  }

  // 1. 基础物理拦截：锁机制与生命周期对齐
  if (currentState.revision !== submission.expectedRevision) {
    throw validationError("stale_continuation_revision_locked");
  }
  if (!currentState.activeContinuation || currentState.activeContinuation.continuationId !== submission.continuationId) {
    throw validationError("continuation_id_mismatch");
  }

  // 2. 核心协议审判：执行协议闭环一致性检查
  const validationResult = runAggregationValidation(submission.receipt, currentState.blueprint);

  if (validationResult.status === "invalid") {
    // Track retries: increment on each invalid submission
    if (!currentState.activeContinuation._receiptRetries) {
      currentState.activeContinuation._receiptRetries = 0;
    }
    currentState.activeContinuation._receiptRetries += 1;

    // If agents are simply missing (schema is otherwise valid), reject WITHOUT
    // downgrading — let the host retry creating the missing agents. Only force
    // downgrade when retries are exhausted or schema is genuinely broken.
    const schemaValid = validationResult.checks.schemaValid;
    const retriesExhausted = currentState.activeContinuation._receiptRetries > MAX_CONTINUATION_RETRIES;

    if (schemaValid && !retriesExhausted) {
      // Rejection: host tried to submit with missing contexts, can still retry
      return validationResult;
    }

    // Schema broken or retries exhausted → permanent downgrade
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
      retryCount: 0,
    };
    logger.info("State transition", {
      event: "state_transition",
      from: "waitingForSubagentAudit",
      to: "waitingForOrchestrationAudit",
      reason: `structured_fallback:${reason}`,
    });
  } else {
    state.step = "waitingForOrchestrationStep0";
    state.activeContinuation = {
      continuationId: `${state.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      checkpoint: "step0_completed",
      expiresAt: Date.now() + 30 * 60 * 1000,
      retryCount: 0,
    };
    logger.info("State transition", {
      event: "state_transition",
      from: "initiated",
      to: "waitingForOrchestrationStep0",
      reason: `structured_fallback:${reason}`,
    });
  }
  state.revision = (state.revision ?? 0) + 1;

  logger.warn("Execution fallback to standard orchestration", {
    event: "execution_downgraded",
    reason,
    newCheckpoint: state.checkpoint,
    newRevision: state.revision,
  });
}

// ── 6. Receipt Schema Validation ─────────────────────────────────────────────

export interface ReceiptValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Lightweight pre-flight format check for an ExecutionReceipt.
 *
 * Only validates **structural integrity** — the receipt is a well-formed object,
 * agents array is present and non-empty, each agent has `id`/`status`/`output`,
 * and the aggregation block exists.
 *
 * This function does **NOT** perform semantic validation (blueprint alignment,
 * execution mismatch, isolation safety, risk-level escalation, etc.).  For the
 * authoritative post-execution validator that includes all those gates,
 * use {@link runAggregationValidation} instead.
 *
 * Returns structured {@link ReceiptValidation} (errors + warnings) so the
 * Host AI can surface fixable issues rather than hitting a hard throw.
 */
export function validateReceipt(receipt: any): ReceiptValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!receipt || typeof receipt !== "object") {
    errors.push("Receipt 不是有效的 JSON 对象");
    return { valid: false, errors, warnings };
  }

  if (receipt.protocol !== "kevlar.blueprint/v1") {
    warnings.push(`协议版本不匹配: 期望 "kevlar.blueprint/v1", 收到 "${receipt.protocol || "缺失"}"`);
  }

  // Agents must be present
  if (!receipt.contexts || !Array.isArray(receipt.contexts)) {
    errors.push('缺少必填字段 "contexts"，必须为数组');
  } else if (receipt.contexts.length === 0) {
    errors.push('"contexts" 数组为空，至少需要一个 agent 结果');
  } else {
    for (let i = 0; i < receipt.contexts.length; i++) {
      const agent = receipt.contexts[i];
      const prefix = `agents[${i}]`;
      if (!agent.id) {
        errors.push(`${prefix}: 缺少必填字段 "id"`);
      }
      if (!agent.status) {
        errors.push(`${prefix}: 缺少必填字段 "status" (应为 "completed" 或 "failed")`);
      } else if (!["completed", "failed"].includes(agent.status)) {
        warnings.push(`${prefix}: 未知的 status 值 "${agent.status}"（仅允许 "completed" / "failed"）`);
      }
      if (!agent.output) {
        errors.push(`${prefix}: 缺少必填字段 "output"`);
      } else if (typeof agent.output === "string") {
        errors.push(`${prefix}: output 是字符串而非对象，必须为包含 findings 数组的 JSON 对象`);
      } else if (typeof agent.output === "object" && agent.status === "completed") {
        if (!Array.isArray(agent.output.findings)) {
          errors.push(`${prefix}: output.findings 必须为数组（无发现时使用空数组 []）`);
        }
      }
    }
  }

  // Aggregation check
  if (!receipt.aggregation || typeof receipt.aggregation !== "object") {
    errors.push('缺少聚合报告 "aggregation"，必须包含 dimensions 数组和 summary 字符串');
  } else {
    if (!Array.isArray(receipt.aggregation.dimensions)) {
      errors.push('aggregation.dimensions 必须为数组');
    }
    if (typeof receipt.aggregation.summary !== "string") {
      errors.push('aggregation.summary 必须为字符串');
    }
  }

  // 提醒调用方：轻量校验只做格式检查，语义校验请调用 runAggregationValidation()
  warnings.push(
    "validateReceipt 仅执行格式校验；后续请调用 runAggregationValidation(receipt, blueprint) 进行完整的语义验证（智能体对齐、执行模式匹配、隔离安全检测等）"
  );

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate a single agent result submitted via slot-based protocol.
 * Checks contextId, status, and output.findings structure.
 */
export function validateSingleAgentResult(
  expectedContextId: string,
  result: any,
): ReceiptValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!result || typeof result !== "object") {
    errors.push("Agent result 不是有效的 JSON 对象");
    return { valid: false, errors, warnings };
  }

  const contextId = result.contextId || result.id || result.agent_id;
  if (!contextId) {
    errors.push('缺少必填字段 "contextId"');
  } else if (contextId !== expectedContextId) {
    errors.push(`contextId 不匹配: 期望 "${expectedContextId}", 收到 "${contextId}"`);
  }

  const status = result.status;
  if (!status) {
    errors.push('缺少必填字段 "status"');
  } else if (!["completed", "failed"].includes(status)) {
    errors.push(`无效的 status 值 "${status}"，仅允许 "completed" 或 "failed"`);
  }

  const output = result.output || result.result || result;
  if (!output || typeof output !== "object") {
    errors.push('缺少必填字段 "output"');
  } else if (!Array.isArray(output.findings)) {
    errors.push('output.findings 必须是数组');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
