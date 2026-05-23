/**
 * Rate Limiter with Semaphore and Exponential Backoff
 * 
 * Shared between mcp_sampling and direct_api modes.
 */

import { logger } from "../utils/logger.js";

// ── Config ────────────────────────────────────────────────────────────────────

interface RateLimitConfig {
  maxConcurrent: number;
  minDelayMs: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxConcurrent: Number(process.env.KEVLAR_MAX_CONCURRENT) || 3,
  minDelayMs: Number(process.env.KEVLAR_MIN_DELAY_MS) || 1000,
};

// ── Semaphore ─────────────────────────────────────────────────────────────────

class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.permits++;
    }
  }
}

// ── Rate Limiter ──────────────────────────────────────────────────────────────

export class RateLimiter {
  private semaphore: Semaphore;
  private minDelayMs: number;
  private lastExecution = 0;
  private maxConcurrent: number;

  constructor(config: RateLimitConfig = DEFAULT_CONFIG) {
    this.semaphore = new Semaphore(config.maxConcurrent);
    this.minDelayMs = config.minDelayMs;
    this.maxConcurrent = config.maxConcurrent;
  }

  async acquire(): Promise<void> {
    await this.semaphore.acquire();
  }

  release(): void {
    this.semaphore.release();
    this.lastExecution = Date.now();
  }

  async waitForDelay(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastExecution;
    if (elapsed < this.minDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.minDelayMs - elapsed)
      );
    }
  }

  getConfig(): RateLimitConfig {
    return {
      maxConcurrent: this.maxConcurrent,
      minDelayMs: this.minDelayMs,
    };
  }
}

// ── Retry Config ──────────────────────────────────────────────────────────────

interface RetryConfig {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  backoffMs: 1000,
  backoffMultiplier: 2,
};

export type RetryableErrorType =
  | "rate_limit_exceeded"
  | "service_unavailable"
  | "timeout"
  | "network_error";

const RETRYABLE_ERRORS: RetryableErrorType[] = [
  "rate_limit_exceeded",
  "service_unavailable",
  "timeout",
  "network_error",
];

export function isRetryableError(errorType: string): errorType is RetryableErrorType {
  return RETRYABLE_ERRORS.includes(errorType as RetryableErrorType);
}

// ── Retry Wrapper ─────────────────────────────────────────────────────────────

interface RetryOptions {
  maxRetries?: number;
  backoffMs?: number;
  backoffMultiplier?: number;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const config: RetryConfig = {
    maxRetries: options.maxRetries ?? DEFAULT_RETRY.maxRetries,
    backoffMs: options.backoffMs ?? DEFAULT_RETRY.backoffMs,
    backoffMultiplier: options.backoffMultiplier ?? DEFAULT_RETRY.backoffMultiplier,
  };

  let lastError: Error;
  let delay = config.backoffMs;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      // Check if error is retryable
      const errorType = getErrorType(lastError);
      if (attempt < config.maxRetries && isRetryableError(errorType)) {
        logger.debug("Retrying after error", {
          event: "retry",
          attempt: attempt + 1,
          errorType,
          delayMs: delay,
        });
        
        options.onRetry?.(attempt + 1, lastError, delay);
        
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= config.backoffMultiplier;
      } else {
        throw lastError;
      }
    }
  }

  throw lastError!;
}

function getErrorType(err: Error): string {
  const message = err.message.toLowerCase();

  // Check by status code first (structured API error responses)
  const statusMatch = message.match(/\b(\d{3})\b/);
  if (statusMatch) {
    const code = statusMatch[1];
    if (code === "429") return "rate_limit_exceeded";
    if (code === "503") return "service_unavailable";
    if (code === "504" || code === "408") return "timeout";
    if (code === "502") return "service_unavailable";
  }

  if (message.includes("rate limit")) return "rate_limit_exceeded";
  if (message.includes("unavailable")) return "service_unavailable";
  if (message.includes("timeout") || message.includes("ETIMEDOUT")) return "timeout";
  if (message.includes("network") || message.includes("ECONNREFUSED") || message.includes("ENOTFOUND")) return "network_error";
  return "unknown";
}

// ── Factory ─────────────────────────────────────────────────────────────────────

export function getRateLimiter(config?: RateLimitConfig): RateLimiter {
  return new RateLimiter(config);
}


