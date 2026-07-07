/**
 * Rate Limiter with Semaphore and Exponential Backoff
 * 
 * Shared by multi-agent parallel execution pipelines.
 */

import { logger, getErrorInfo } from "../utils/observability.js";

// ── Config ────────────────────────────────────────────────────────────────────

export function clampInt(envKey: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[envKey]);
  if (isNaN(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

interface RateLimitConfig {
  maxConcurrent: number;
  minDelayMs: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxConcurrent: clampInt("KEVLAR_MAX_CONCURRENT", 3, 1, 10),
  minDelayMs: clampInt("KEVLAR_MIN_DELAY_MS", 1000, 0, 30000),
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
  private activeCount = 0;

  constructor(config: RateLimitConfig = DEFAULT_CONFIG) {
    this.semaphore = new Semaphore(config.maxConcurrent);
    this.minDelayMs = config.minDelayMs;
    this.maxConcurrent = config.maxConcurrent;
  }

  async acquire(): Promise<void> {
    await this.semaphore.acquire();
    this.activeCount++;
  }

  release(): void {
    this.activeCount--;
    this.semaphore.release();
    this.lastExecution = Date.now();
  }

  async waitForDelay(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) return;

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
  maxRetries: clampInt("KEVLAR_RETRY_MAX", 3, 0, 10),
  backoffMs: Math.max(0, Number(process.env.KEVLAR_RETRY_BACKOFF_MS) || 1000),
  backoffMultiplier: Math.max(1, Number(process.env.KEVLAR_RETRY_BACKOFF_MULTIPLIER) || 2),
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
      lastError = err instanceof Error ? err : new Error(getErrorInfo(err).message);
      
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

// ── Circuit Breaker ────────────────────────────────────────────────────────────

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

interface CircuitBreakerEvent {
  timestamp: number;
  success: boolean;
}

export class CircuitBreaker {
  private events: CircuitBreakerEvent[] = [];
  private windowMs: number;
  private failureThreshold: number;
  private minCalls: number;
  private open = false;

  constructor(options?: { windowMs?: number; failureThreshold?: number; minCalls?: number }) {
    this.windowMs = options?.windowMs ?? 120_000;
    this.failureThreshold = options?.failureThreshold ?? 0.5;
    this.minCalls = options?.minCalls ?? 5;
  }

  recordSuccess(): void {
    this.prune();
    this.events.push({ timestamp: Date.now(), success: true });
    this.updateState();
  }

  recordFailure(): void {
    this.prune();
    this.events.push({ timestamp: Date.now(), success: false });
    this.updateState();
  }

  isOpen(): boolean {
    this.prune();
    this.updateState();
    return this.open;
  }

  check(): void {
    if (this.isOpen()) {
      throw new CircuitBreakerOpenError(
        "Circuit breaker is open — failure rate exceeds threshold. Downgrading to orchestration mode."
      );
    }
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.events = this.events.filter(e => e.timestamp >= cutoff);
  }

  private updateState(): void {
    if (this.events.length < this.minCalls) return;
    const failures = this.events.filter(e => !e.success).length;
    this.open = failures / this.events.length > this.failureThreshold;
  }

  reset(): void {
    this.events = [];
    this.open = false;
  }
}

export const apiCircuitBreaker = new CircuitBreaker();


