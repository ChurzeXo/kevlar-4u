/**
 * Progress Metadata Protocol
 *
 * Each wizard tool response carries a machine-parseable progress
 * envelope so the host AI can display audit pipeline progress to users.
 *
 * Format embedded in ToolResult text content:
 *   [KEVLAR_PROGRESS]
 *   { ... json ... }
 *   [/KEVLAR_PROGRESS]
 */

const PROGRESS_MARKER_OPEN = "[KEVLAR_PROGRESS]";
const PROGRESS_MARKER_CLOSE = "[/KEVLAR_PROGRESS]";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProgressStep {
  name: string;
  status: "done" | "running" | "pending";
  /** Only meaningful when status is "running" — e.g. "3/6" */
  progress?: string;
}

export interface ProgressMetadata {
  currentStep: string;
  totalSteps: number;
  /** Estimated remaining seconds (0 = unknown) */
  estimatedRemainingSeconds: number;
  steps: ProgressStep[];
}

// ── Builders ─────────────────────────────────────────────────────────────────

/** Create a progress metadata block for the current step. */
export function buildProgress(meta: ProgressMetadata): string {
  return [
    PROGRESS_MARKER_OPEN,
    JSON.stringify(meta),
    PROGRESS_MARKER_CLOSE,
  ].join("\n");
}

// ── Step Mapping ─────────────────────────────────────────────────────────────

const STEP_LABEL: Record<string, string> = {
  waitingForRegionSelection: "region_selection",
  systemAudit: "system_preaudit",
  waitingForOrchestrationStep0: "preaudit_decoding",
  waitingForOrchestrationAudit: "preaudit_dimensions",
  waitingForOrchestrationFinal: "preaudit_arbitration",
  waitingForSubagentAudit: "preaudit_parallel",
  checkPersonaInventory: "persona_inventory",
  waitingForPersonaCreation: "persona_creation",
  waitingForReviewDecision: "reviewer_selection",
  waitingForReviewerConfirmation: "reviewer_confirmation",
  waitingForPersonaAudit: "persona_review",
  waitingForNextRound: "review_complete",
  rstConfirmation: "rst_confirmation",
  completed: "done",
};

/** Map a wizard step to a progress snapshot. */
export function progressForStep(step: string, dimensionCount?: number): string {
  const label = STEP_LABEL[step] || step;

  const allSteps: ProgressStep[] = [
    { name: "region_selection", status: "done" },
    { name: "preaudit_decoding", status: "pending" },
    { name: "preaudit_dimensions", status: "pending" },
    { name: "preaudit_arbitration", status: "pending" },
    { name: "persona_inventory", status: "pending" },
    { name: "reviewer_selection", status: "pending" },
    { name: "persona_review", status: "pending" },
  ];

  const stepOrder = allSteps.map(s => s.name);
  let currentIdx = stepOrder.indexOf(label);
  if (currentIdx === -1) currentIdx = stepOrder.length;

  for (let i = 0; i < stepOrder.length; i++) {
    if (i < currentIdx) allSteps[i].status = "done";
    else if (i === currentIdx) allSteps[i].status = "running";
    else allSteps[i].status = "pending";
  }

  if (label === "preaudit_parallel" && dimensionCount !== undefined) {
    const runningIdx = allSteps.findIndex(s => s.name === "preaudit_dimensions");
    if (runningIdx !== -1) {
      allSteps[runningIdx].status = "running";
      allSteps[runningIdx].progress = `0/${dimensionCount}`;
    }
  }

  const remainingMap: Record<string, number> = {
    region_selection: 120,
    preaudit_decoding: 60,
    preaudit_dimensions: 30,
    preaudit_arbitration: 15,
    preaudit_parallel: 30,
    persona_inventory: 5,
    persona_review: 30,
  };

  return buildProgress({
    currentStep: label,
    totalSteps: allSteps.length,
    estimatedRemainingSeconds: remainingMap[label] ?? 0,
    steps: allSteps,
  });
}
