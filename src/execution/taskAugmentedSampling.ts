import type { Persona } from "../utils/parser.js";
import type { PreAuditDimensionResult } from "./reviewSteps.js";
import { buildIsolatedSystemAuditorPrompt, buildIsolatedSystemAuditorMessage } from "../prompts/reviewWizard.js";
import { logger } from "../utils/logger.js";
import { getErrorInfo } from "../utils/observability.js";
import { internalError } from "../utils/errors.js";

type TaskState = "working" | "input_required" | "completed" | "failed" | "cancelled";

interface TaskHandle {
  taskId: string;
  status: TaskState;
  pollInterval?: number;
  ttl?: number;
}

function stripCodeFence(text: string): string {
  if (!text.startsWith("```")) return text;
  return text
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeTaskAugmentedSampling(
  server: any,
  auditors: Persona[],
  content: string,
  localFindings: any[],
  step0Result?: any,
  webContextMap?: Record<string, string>,
  timingContext?: string,
  maxConcurrency: number = 6,
): Promise<PreAuditDimensionResult[]> {
  const DEFAULT_POLL_MS = Number(process.env.KEVLAR_TASK_POLL_MS) || 1000;
  const TASK_TTL_MS = Number(process.env.KEVLAR_TASK_TTL_MS) || 300000;
  const MAX_TOTAL_TIMEOUT_MS = Number(process.env.KEVLAR_TASK_TOTAL_TIMEOUT_MS) || 600000;

  logger.info("Starting task-augmented sampling", {
    event: "task_augmented_sampling_start",
    auditorCount: auditors.length,
    maxConcurrency,
  });

  const tasks: Array<{
    auditorId: string;
    auditorName: string;
    taskId?: string;
    status: "pending" | "running" | "done" | "failed" | "skipped";
    result?: PreAuditDimensionResult;
  }> = auditors.map((a) => ({
    auditorId: a.meta.id,
    auditorName: a.meta.name,
    status: "pending",
  }));

  // ── Phase 1: Launch all tasks in parallel ──────────────────────────────
  const launchPromises = auditors.map(async (auditor, idx) => {
    const taskEntry = tasks[idx];
    try {
      const auditContent =
        timingContext && auditor.meta.id === "social_risk"
          ? [content, "", timingContext].join("\n")
          : content;

      let webContext = "";
      if (webContextMap && Object.keys(webContextMap).length > 0) {
        const relevantEntries = Object.entries(webContextMap)
          .filter(([, ctx]) => ctx.length > 0)
          .map(([kw, ctx]) => `### ${kw}\n${ctx}`);
        if (relevantEntries.length > 0) {
          webContext = `联网验证结果（Turn 1 已完成检索）：\n\n${relevantEntries.join("\n\n")}`;
        }
      }

      const createResult = await server.request(
        {
          method: "sampling/createMessage",
          params: {
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: buildIsolatedSystemAuditorMessage(auditContent, auditor, {
                    localFindings,
                    step0Result,
                    timingContext:
                      timingContext && auditor.meta.id === "social_risk"
                        ? timingContext
                        : undefined,
                    webContext: webContext || undefined,
                  }),
                },
              },
            ],
            maxTokens: 2048,
            systemPrompt: buildIsolatedSystemAuditorPrompt(auditor),
            includeContext: "none" as const,
          },
        },
        { _def: {}, _type: {}, parse: (v: any) => v },
        {
          task: { ttl: TASK_TTL_MS },
          maxTotalTimeout: MAX_TOTAL_TIMEOUT_MS,
        },
      );

      if (createResult && createResult.task && createResult.task.taskId) {
        taskEntry.taskId = createResult.task.taskId;
        taskEntry.status = "running";
        logger.debug("Task launched", {
          event: "task_augmented_launched",
          auditorId: auditor.meta.id,
          taskId: createResult.task.taskId,
        });
      } else {
        throw internalError("Task creation did not return a taskId");
      }
    } catch (err: any) {
      const info = getErrorInfo(err);
      if (err?.code === -1 || info.code === "REJECTED") {
        logger.info("User rejected sampling for auditor", {
          event: "task_augmented_user_rejected",
          auditorId: auditor.meta.id,
        });
        taskEntry.status = "skipped";
        taskEntry.result = { id: auditor.meta.id, name: auditor.meta.name, findings: [] };
      } else {
        logger.warn("Failed to create task for auditor", {
          event: "task_augmented_launch_failed",
          auditorId: auditor.meta.id,
          error: info.message,
        });
        taskEntry.status = "failed";
        taskEntry.result = { id: auditor.meta.id, name: auditor.meta.name, findings: [] };
      }
    }
  });

  await Promise.all(launchPromises);

  // ── Phase 2: Poll all running tasks until terminal ─────────────────────
  const runningTasks = tasks.filter((t) => t.status === "running");
  if (runningTasks.length === 0) {
    logger.info("No tasks to poll (all launched or failed)", {
      event: "task_augmented_no_poll",
      tasks: tasks.map((t) => ({ id: t.auditorId, status: t.status })),
    });
    return tasks
      .filter((t) => t.result)
      .map((t) => t.result!);
  }

  const startTime = Date.now();

  while (true) {
    const stillRunning = tasks.filter((t) => t.status === "running");
    if (stillRunning.length === 0) break;

    if (Date.now() - startTime > MAX_TOTAL_TIMEOUT_MS) {
      logger.warn("Task-augmented total timeout reached", {
        event: "task_augmented_total_timeout",
        runningCount: stillRunning.length,
      });
      for (const t of stillRunning) {
        t.status = "failed";
        t.result = { id: t.auditorId, name: t.auditorName, findings: [] };
      }
      break;
    }

    // Poll each running task
    const pollPromises = stillRunning.map(async (taskEntry) => {
      try {
        const taskStatus = await server.request(
          {
            method: "tasks/get",
            params: { taskId: taskEntry.taskId },
          },
          { _def: {}, _type: {}, parse: (v: any) => v },
          { timeout: 15000 },
        );

        if (!taskStatus) {
          taskEntry.status = "failed";
          taskEntry.result = { id: taskEntry.auditorId, name: taskEntry.auditorName, findings: [] };
          return;
        }

        const status: TaskState = taskStatus.status || "working";

        switch (status) {
          case "completed": {
            try {
              const finalResult = await server.request(
                {
                  method: "tasks/result",
                  params: { taskId: taskEntry.taskId },
                },
                { _def: {}, _type: {}, parse: (v: any) => v },
                {
                  relatedTask: { taskId: taskEntry.taskId! },
                  timeout: 30000,
                },
              );

              const textContent =
                finalResult?.content?.text || finalResult?.content?.type === "text"
                  ? finalResult.content.text
                  : "";
              const parsed = JSON.parse(stripCodeFence(textContent.trim()));
              taskEntry.result = {
                id: taskEntry.auditorId,
                name: taskEntry.auditorName,
                findings: Array.isArray(parsed.findings) ? parsed.findings : [],
              };
              taskEntry.status = "done";
              logger.debug("Task completed", {
                event: "task_augmented_completed",
                auditorId: taskEntry.auditorId,
              });
            } catch (resultErr: any) {
              const info = getErrorInfo(resultErr);
              logger.warn("Failed to get task result", {
                event: "task_augmented_result_failed",
                auditorId: taskEntry.auditorId,
                error: info.message,
              });
              taskEntry.result = { id: taskEntry.auditorId, name: taskEntry.auditorName, findings: [] };
              taskEntry.status = "failed";
            }
            break;
          }
          case "input_required": {
            try {
              const finalResult = await server.request(
                {
                  method: "tasks/result",
                  params: { taskId: taskEntry.taskId },
                },
                { _def: {}, _type: {}, parse: (v: any) => v },
                {
                  relatedTask: { taskId: taskEntry.taskId! },
                  timeout: 60000,
                },
              );

              const textContent =
                finalResult?.content?.text || finalResult?.content?.type === "text"
                  ? finalResult.content.text
                  : "";
              const parsed = JSON.parse(stripCodeFence(textContent.trim()));
              taskEntry.result = {
                id: taskEntry.auditorId,
                name: taskEntry.auditorName,
                findings: Array.isArray(parsed.findings) ? parsed.findings : [],
              };
              taskEntry.status = "done";
            } catch (elicitErr: any) {
              const info = getErrorInfo(elicitErr);
              logger.warn("Failed to process input_required", {
                event: "task_augmented_input_required_failed",
                auditorId: taskEntry.auditorId,
                error: info.message,
              });
              taskEntry.result = { id: taskEntry.auditorId, name: taskEntry.auditorName, findings: [] };
              taskEntry.status = "failed";
            }
            break;
          }
          case "failed": {
            taskEntry.result = { id: taskEntry.auditorId, name: taskEntry.auditorName, findings: [] };
            taskEntry.status = "failed";
            logger.warn("Task failed remotely", {
              event: "task_augmented_remote_failed",
              auditorId: taskEntry.auditorId,
              statusMessage: taskStatus.statusMessage,
            });
            break;
          }
          case "cancelled": {
            taskEntry.result = { id: taskEntry.auditorId, name: taskEntry.auditorName, findings: [] };
            taskEntry.status = "skipped";
            logger.info("Task cancelled", {
              event: "task_augmented_cancelled",
              auditorId: taskEntry.auditorId,
            });
            break;
          }
          default: {
            break;
          }
        }
      } catch (pollErr: any) {
        const info = getErrorInfo(pollErr);
        if (pollErr?.code === -32602) {
          // Invalid params - task already terminal, ignore
          logger.debug("tasks/get returned invalid params (task already terminal)", {
            event: "task_augmented_poll_invalid_params",
            auditorId: taskEntry.auditorId,
          });
        } else {
          logger.warn("Poll failed for auditor", {
            event: "task_augmented_poll_failed",
            auditorId: taskEntry.auditorId,
            error: info.message,
          });
          taskEntry.result = { id: taskEntry.auditorId, name: taskEntry.auditorName, findings: [] };
          taskEntry.status = "failed";
        }
      }
    });

    await Promise.all(pollPromises);

    // Respect minimum poll interval before next round
    await sleep(DEFAULT_POLL_MS);
  }

  const results = tasks
    .filter((t) => t.result)
    .map((t) => t.result!);

  // Ensure all auditors have results
  const resultMap = new Map(results.map((r) => [r.id, r]));
  for (const auditor of auditors) {
    if (!resultMap.has(auditor.meta.id)) {
      results.push({ id: auditor.meta.id, name: auditor.meta.name, findings: [] });
    }
  }

  logger.info("Task-augmented sampling complete", {
    event: "task_augmented_sampling_complete",
    total: results.length,
    withFindings: results.filter((r) => r.findings.length > 0).length,
  });

  return results;
}
