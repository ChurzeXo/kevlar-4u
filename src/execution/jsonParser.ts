/**
 * JSON Parsing Fallback Chain (MECP §6.4)
 *
 * Implements the 4-step parsing chain for structured agent outputs:
 *   1. JSON.parse(rawResponse) + Zod
 *   2. JSON5.parse + Zod (tolerates trailing commas, single quotes, etc.)
 *   3. Regex extraction (```json ... ```) + JSON.parse + Zod
 *   4. Line-level heuristic: try each line as standalone JSON
 *
 * If all 4 steps fail and a repairFn is provided, LLM Judge re-parse
 * is attempted as an additional rescue step before returning failure.
 *
 * Also defines Zod schemas for Finding and AgentOutput per MECP Appendix A.
 */

import { z } from "zod";
import JSON5 from "json5";

// ── Zod Schemas (MECP Appendix A) ────────────────────────────────────────────

export const FindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["low", "medium", "high"]),
  description: z.string().min(1),
  evidence: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

export const AgentOutputSchema = z.object({
  findings: z.array(FindingSchema).min(0),
  confidence: z.number().min(0).max(1),
  rawResponse: z.string(),
  usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  }).optional(),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;

// ── JSON Block Regex ─────────────────────────────────────────────────────────

const JSON_BLOCK_REGEX = /```(?:json)?\s*([\s\S]*?)\s*```/;

// ── LLM Judge Repair Function ────────────────────────────────────────────────

export type JsonRepairFn = (brokenJson: string, error: string) => Promise<string>;

// ── 4-Step Parsing Chain ─────────────────────────────────────────────────────

export interface ParseResult<T> {
  success: true;
  data: T;
  step: "json_parse" | "json5_parse" | "regex_extract" | "llm_repair";
}

export interface ParseFailure {
  success: false;
  error: string;
  raw: string;
}

export async function parseStructuredOutput<T>(
  raw: string,
  schema: z.ZodSchema<T>,
  repairFn?: JsonRepairFn,
): Promise<ParseResult<T> | ParseFailure> {
  // Step 1: Direct JSON.parse + Zod validation
  try {
    const parsed = JSON.parse(raw);
    const result = schema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data, step: "json_parse" };
    }
  } catch {
    // fall through to step 2
  }

  // Step 2: JSON5.parse + Zod (tolerates trailing commas, single quotes, etc.)
  try {
    const parsed = JSON5.parse(raw);
    const result = schema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data, step: "json5_parse" };
    }
  } catch {
    // fall through to step 3
  }

  // Step 3: Regex extraction of ```json ... ``` block
  const match = raw.match(JSON_BLOCK_REGEX);
  if (match) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const result = schema.safeParse(parsed);
      if (result.success) {
        return { success: true, data: result.data, step: "regex_extract" };
      }
    } catch {
      // fall through to step 4
    }
  }

  // Step 3.5: LLM Judge re-parse (bonus rescue before line-level heuristic)
  if (repairFn) {
    try {
      const repaired = await repairFn(raw, "Failed to parse as valid JSON matching the expected schema");
      const trimmed = repaired.trim();
      const parsed = JSON.parse(trimmed);
      const result = schema.safeParse(parsed);
      if (result.success) {
        return { success: true, data: result.data, step: "llm_repair" };
      }
    } catch {
      // fall through to step 4
    }
  }

  // Step 4: Line-level heuristic — try each line as standalone JSON
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const result = schema.safeParse(parsed);
      if (result.success) {
        return { success: true, data: result.data, step: "regex_extract" };
      }
    } catch {
      // try next line
    }
  }

  return { success: false, error: "Failed to parse structured output after all fallback steps", raw };
}

/**
 * Attempt to parse a findings string as structured JSON.
 * If it's already JSON-like, validate with FindingSchema.
 * Otherwise return the raw text for normal text-based rendering.
 */
export function tryParseFindingsJson(
  content: string,
): { structured: true; findings: Finding[] } | { structured: false } {
  const trimmed = content.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return { structured: false };
  }

  // Try strict JSON first
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Fall back to JSON5 (tolerates trailing commas, single quotes, etc.)
    try {
      parsed = JSON5.parse(trimmed);
    } catch {
      return { structured: false };
    }
  }

  if (Array.isArray(parsed)) {
    const result = z.array(FindingSchema).safeParse(parsed);
    if (result.success) {
      return { structured: true, findings: result.data };
    }
  }
  if (typeof parsed === "object" && parsed && "findings" in parsed) {
    const result = z.array(FindingSchema).safeParse((parsed as Record<string, unknown>).findings);
    if (result.success) {
      return { structured: true, findings: result.data };
    }
  }

  return { structured: false };
}
