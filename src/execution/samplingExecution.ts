import type { Persona } from "../utils/parser.js";
import type { PreAuditDimensionResult } from "./reviewSteps.js";
import type { MultiTurnSamplingFunction } from "./base.js";
import { executeTaskAugmentedSampling } from "./taskAugmentedSampling.js";
import { runSystemAuditors } from "./reviewSteps.js";
import { logger, getErrorInfo } from "../utils/observability.js";
import { readConfig } from "./config.js";

export interface SamplingReviewOptions {
  localFindings: any[];
  step0Result?: any;
  webContextMap?: Record<string, string>;
  timingContext?: string;
  maxConcurrency?: number;
  samplingFn?: MultiTurnSamplingFunction;
}

export async function executeSamplingReview(
  server: any,
  auditors: Persona[],
  content: string,
  options: SamplingReviewOptions,
): Promise<PreAuditDimensionResult[]> {
  const {
    localFindings,
    step0Result,
    webContextMap,
    timingContext,
    maxConcurrency = 6,
    samplingFn,
  } = options;

  const taskAugEnabled = process.env.KEVLAR_ENABLE_TASK_AUGMENTED !== "0";

  if (taskAugEnabled) {
    try {
      logger.info("Attempting task-augmented sampling", {
        event: "sampling_exec_task_augmented",
        auditorCount: auditors.length,
      });
      const results = await executeTaskAugmentedSampling(
        server,
        auditors,
        content,
        localFindings,
        step0Result,
        webContextMap,
        timingContext,
        maxConcurrency,
      );
      logger.info("Task-augmented sampling succeeded", {
        event: "sampling_exec_task_augmented_success",
        count: results.length,
      });
      return results;
    } catch (err) {
      const info = getErrorInfo(err);
      logger.warn("Task-augmented sampling failed, degrading to serial", {
        event: "sampling_exec_degrade_to_serial",
        error: info.message,
      });
    }
  }

  if (samplingFn) {
    try {
      logger.info("Attempting serial MCP sampling", {
        event: "sampling_exec_serial",
        auditorCount: auditors.length,
      });
      const caller = {
        call: (params: any) => samplingFn(params),
      };
      const results = await runSystemAuditors(
        content,
        auditors,
        async (params) => {
          const response = await samplingFn(params);
          return { content: response.content, stopReason: response.stopReason };
        },
        timingContext,
        localFindings,
        step0Result,
        webContextMap,
      );
      logger.info("Serial MCP sampling succeeded", {
        event: "sampling_exec_serial_success",
        count: results.length,
      });
      return results;
    } catch (err) {
      const info = getErrorInfo(err);
      logger.warn("Serial sampling failed, degrading to host orchestration", {
        event: "sampling_exec_degrade_to_orchestration",
        error: info.message,
      });
      throw err;
    }
  }

  throw new Error("No sampling function available and task-augmented is disabled");
}
