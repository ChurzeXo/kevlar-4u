/**
 * Base types and interfaces for Kevlar execution modes
 */

import type { Persona } from "../utils/parser.js";

// ── Execution Mode Types ───────────────────────────────────────────────────────

export type ExecutionMode = "orchestration" | "mcp_sampling" | "direct_api";

export type ResolveableMode = ExecutionMode | "auto";

// ── Sampling Function Type ───────────────────────────────────────────────────

export type SamplingFunction = (params: {
  systemPrompt: string;
  message: string;
  maxTokens?: number;
}) => Promise<{ content: string; stopReason?: string }>;

export type MultiTurnSamplingFunction = (params: {
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
}) => Promise<{ content: string; stopReason?: string }>;

// ── Execution Context ─────────────────────────────────────────────────────────

export interface ExecutionContext {
  skillsDir: string;
  personas: Persona[];
  content: string;
  context?: string;
  samplingFn?: SamplingFunction;
  multiTurnSamplingFn?: MultiTurnSamplingFunction;
}

// ── Execution Result ─────────────────────────────────────────────────────────

export interface ExecutionResult {
  report: string;
  personas: string[]; // participating persona IDs
  mode: ExecutionMode;
  partialFailures?: Array<{ personaId: string; error: string }>;
}

// ── Execution Handler Interface ─────────────────────────────────────────────

export interface ExecutionHandler {
  mode: ExecutionMode;
  /** Check if current environment supports this mode */
  canExecute(): boolean;
  /** Execute the review */
  execute(ctx: ExecutionContext): Promise<ExecutionResult>;
  /** Default priority (lower number = higher priority) */
  priority: number;
}

// ── Mode Availability ─────────────────────────────────────────────────────────

export interface ModeStatus {
  mode: ExecutionMode;
  available: boolean;
  reason?: string;
}

export interface ModesInfo {
  modes: ModeStatus[];
  recommendedMode: ExecutionMode;
  currentMode: ResolveableMode;
  resolvedMode: ExecutionMode;
}
