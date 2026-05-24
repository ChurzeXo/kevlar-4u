/**
 * Kevlar-4u Configuration Management
 * 
 * Reads and writes the kevlar-config.json file for user preferences.
 * API keys are NEVER stored here - only environment variables.
 */

import { readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { logger, getErrorInfo } from "../utils/observability.js";
import type { ExecutionMode, ResolveableMode } from "./base.js";

// ── Config Schema ─────────────────────────────────────────────────────────────

interface KevlarConfig {
  mode: ResolveableMode;
  multiAgent: {
    maxConcurrency: number;
    timeoutMs: number;
  };
  personaOrder: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: KevlarConfig = {
  mode: "auto",
  multiAgent: {
    maxConcurrency: 3,
    timeoutMs: 60000,
  },
  personaOrder: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ── Config File Path ─────────────────────────────────────────────────────────

let configPath: string | null = null;

export function setConfigPath(skillsDir: string): void {
  configPath = path.join(skillsDir, "kevlar-config.json");
}

// ── Read Config ──────────────────────────────────────────────────────────────

export function readConfig(): KevlarConfig {
  if (!configPath) {
    logger.warn("Config path not initialized, using defaults", { event: "config_not_initialized" });
    return { ...DEFAULT_CONFIG };
  }

  let result: KevlarConfig;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<KevlarConfig>;
    result = { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    // Config doesn't exist or is invalid - use defaults
    result = { ...DEFAULT_CONFIG };
  }

  const envMaxConcurrency = process.env.KEVLAR_MAX_CONCURRENT;
  if (envMaxConcurrency) {
    const parsed = parseInt(envMaxConcurrency, 10);
    if (!isNaN(parsed) && isValidConcurrency(parsed)) {
      result.multiAgent = { ...result.multiAgent, maxConcurrency: parsed };
    }
  }

  return result;
}

export async function readConfigAsync(): Promise<KevlarConfig> {
  // Kept for backward compatibility, using synchronous read for safety
  return readConfig();
}

// ── Write Config ─────────────────────────────────────────────────────────────

interface UpdateConfigOptions {
  mode?: ResolveableMode;
  maxConcurrency?: number;
  personaOrder?: string[];
}

export async function updateConfig(options: UpdateConfigOptions): Promise<KevlarConfig> {
  if (!configPath) {
    throw new Error("Config path not initialized");
  }

  // Use synchronous atomic read-merge-write to prevent async race conditions
  const current = readConfig();
  const updated: KevlarConfig = {
    ...current,
    multiAgent: {
      ...current.multiAgent,
    },
    updatedAt: new Date().toISOString(),
  };

  if (options.mode !== undefined) {
    updated.mode = options.mode;
  }
  if (options.maxConcurrency !== undefined) {
    updated.multiAgent.maxConcurrency = options.maxConcurrency;
  }
  if (options.personaOrder !== undefined) {
    updated.personaOrder = options.personaOrder;
  }

  try {
    writeFileSync(configPath, JSON.stringify(updated, null, 2), "utf-8");
    logger.info("Config updated", { event: "config_update", path: configPath, options });
    return updated;
  } catch (err) {
    const info = getErrorInfo(err);
    logger.error("Failed to write config", { event: "config_write_error", error: info.code, message: info.message });
    throw err;
  }
}

// ── Config Validation ─────────────────────────────────────────────────────────

export function isValidMode(mode: string): mode is ExecutionMode | "auto" {
  return ["auto", "orchestration", "mcp_sampling", "direct_api"].includes(mode);
}

export function isValidConcurrency(concurrency: number): boolean {
  return Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 10;
}
