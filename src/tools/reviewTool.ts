import { loadAllPersonas, Persona } from "../utils/parser.js";
import { ToolResult } from "../utils/types.js";
import { executeReview, loadPersonasForReview, MAX_PERSONAS } from "../execution/index.js";
import type { ExecutionContext, ResolveableMode, SamplingFunction } from "../execution/base.js";
import type { DimensionsConfig } from "../execution/dimensions.js";
import { DEFAULT_DIMENSIONS_CONFIG } from "../execution/dimensions.js";
import { getErrorInfo } from "../utils/observability.js";

const MAX_CONTENT_LENGTH = 100_000;
const MAX_CONTEXT_LENGTH = 5_000;

// ── Validation helpers ──────────────────────────────────────────────────────

function validateContentPresence(content: unknown): ToolResult | null {
  if (!content || typeof content !== "string") {
    return {
      content: [{ type: "text", text: "❌ 请提供要评测的文案内容" }],
      isError: true,
    };
  }
  return null;
}

function validateContentLength(content: string): ToolResult | null {
  if (content.length > MAX_CONTENT_LENGTH) {
    return {
      content: [{
        type: "text",
        text: `❌ 文案内容超出长度限制（${MAX_CONTENT_LENGTH}字符）。当前长度：${content.length}字符`,
      }],
      isError: true,
    };
  }
  return null;
}

function validateContextLength(context: string | undefined): ToolResult | null {
  if (context && context.length > MAX_CONTEXT_LENGTH) {
    return {
      content: [{
        type: "text",
        text: `❌ 上下文说明超出长度限制（${MAX_CONTEXT_LENGTH}字符）`,
      }],
      isError: true,
    };
  }
  return null;
}

function validatePersonaCount(personaIds: string[] | undefined): ToolResult | null {
  if (personaIds && personaIds.length > MAX_PERSONAS) {
    return {
      content: [{
        type: "text",
        text: `❌ 选择的评审员数量超出限制（最多${MAX_PERSONAS}个）`,
      }],
      isError: true,
    };
  }
  return null;
}

function validateInput(
  input: {
    content: string;
    context?: string;
    persona_ids?: string[];
  }
): ToolResult | null {
  return (
    validateContentPresence(input.content) ??
    validateContentLength(input.content) ??
    validateContextLength(input.context) ??
    validatePersonaCount(input.persona_ids)
  );
}

// ── Persona loading helper ──────────────────────────────────────────────────

type PersonaLoadResult = { personas: Persona[] };
type PersonaLoadError = ToolResult;

function isErrorResult(result: PersonaLoadResult | PersonaLoadError): result is PersonaLoadError {
  return "isError" in result;
}

async function loadReviewPersonas(
  skillsDir: string,
  personaIds?: string[]
): Promise<PersonaLoadResult | PersonaLoadError> {
  const loadResult = await loadPersonasForReview(skillsDir, personaIds);
  const { personas, missingIds } = loadResult;

  if (missingIds && missingIds.length > 0) {
    return {
      content: [{
        type: "text",
        text: `❌ 找不到以下评审员：${missingIds.join("、")}。请先查看可用评审员列表。`,
      }],
      isError: true,
    };
  }

  if (personas.length === 0) {
    return {
      content: [{
        type: "text",
        text: "⚠️ 当前没有可用评审员。请先创建自定义评审员。",
      }],
      isError: true,
    };
  }

  return { personas };
}

// ── Continuation helper ─────────────────────────────────────────────────────

async function computeRemainingPersonas(
  skillsDir: string,
  activePersonas: Persona[]
): Promise<Persona[]> {
  const allPersonas = await loadAllPersonas(skillsDir);
  const activeIds = new Set(activePersonas.map((p) => p.meta.id));
  return allPersonas.filter((p) => !activeIds.has(p.meta.id));
}

function buildContinuationNote(remainingPersonas: Persona[]): string {
  if (remainingPersonas.length === 0) return "";
  const names = remainingPersonas.map((p) => p.meta.name).join("、");
  return `

---

## 🔄 延续测试

本轮有 **${remainingPersonas.length} 个人设未参与评测**：${names}。

**完成汇总报告后：**
1. 向用户展示报告
2. 询问是否要用剩余评审员（${names}）继续评测
3. 用户同意则启动新一轮评测（复用本次内容）
4. 用户拒绝则结束`;
}

// ── Main entry ──────────────────────────────────────────────────────────────

export async function handleReviewContent(
  skillsDir: string,
  input: {
    content: string;
    persona_ids?: string[];
    context?: string;
    mode?: ResolveableMode;
    samplingFn?: SamplingFunction;
    dimensions?: DimensionsConfig;
  }
): Promise<ToolResult> {
  const validationError = validateInput(input);
  if (validationError) return validationError;

  const personasResult = await loadReviewPersonas(skillsDir, input.persona_ids);
  if (isErrorResult(personasResult)) return personasResult;
  const { personas } = personasResult;

  const remainingPersonas = await computeRemainingPersonas(skillsDir, personas);

  const mode = input.mode || "auto";

  try {
    const ctx: ExecutionContext = {
      skillsDir,
      personas,
      content: input.content,
      context: input.context,
      samplingFn: input.samplingFn,
      dimensions: input.dimensions ?? DEFAULT_DIMENSIONS_CONFIG,
    };

    const result = await executeReview(mode, ctx);
    const continuationNote = buildContinuationNote(remainingPersonas);

    return {
      content: [{ type: "text", text: result.report + continuationNote }],
    };
  } catch (err) {
    const info = getErrorInfo(err);
    return {
      content: [{ type: "text", text: `❌ 评测执行失败：${info.message}` }],
      isError: true,
    };
  }
}
