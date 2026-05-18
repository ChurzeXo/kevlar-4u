/**
 * Kevlar Configuration Management
 * 
 * Reads and writes the kevlar-config.json file for user preferences.
 * API keys are NEVER stored here - only environment variables.
 */

import { readFileSync, promises as fsp } from "fs";
import * as path from "path";
import { logger } from "../utils/logger.js";
import type { ExecutionMode, ResolveableMode } from "./base.js";

// ── Config Schema ─────────────────────────────────────────────────────────────

export interface KevlarConfig {
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

export function getConfigPath(): string | null {
  return configPath;
}

// ── Read Config ──────────────────────────────────────────────────────────────

export function readConfig(): KevlarConfig {
  if (!configPath) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<KevlarConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    // Config doesn't exist or is invalid - use defaults
    return { ...DEFAULT_CONFIG };
  }
}

export async function readConfigAsync(): Promise<KevlarConfig> {
  if (!configPath) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = await fsp.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<KevlarConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ── Write Config ─────────────────────────────────────────────────────────────

export interface UpdateConfigOptions {
  mode?: ResolveableMode;
  maxConcurrency?: number;
  personaOrder?: string[];
}

export async function updateConfig(options: UpdateConfigOptions): Promise<KevlarConfig> {
  if (!configPath) {
    throw new Error("Config path not initialized");
  }

  const current = await readConfigAsync();
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
    await fsp.writeFile(configPath, JSON.stringify(updated, null, 2), "utf-8");
    logger.info("Config updated", { event: "config_update", path: configPath, options });
    return updated;
  } catch (err) {
    logger.error("Failed to write config", { event: "config_write_error", error: String(err) });
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
