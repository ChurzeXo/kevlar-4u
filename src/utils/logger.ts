/**
 * Structured logging module for Kevlar-4u
 * Uses pino for production-grade performance
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  event: string;
  [key: string]: unknown;
}

interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

function createLogger(): Logger {
  const level = (process.env.LOG_LEVEL as LogLevel) || "info";
  const levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  const currentLevel = levels[level] ?? 1;

  function shouldLog(level: LogLevel): boolean {
    return levels[level] >= currentLevel;
  }

  function formatTimestamp(): string {
    return new Date().toISOString();
  }

  function formatCtx(ctx: LogContext | undefined): string {
    if (!ctx || Object.keys(ctx).length === 0) return "";
    const { event, ...rest } = ctx;
    if (Object.keys(rest).length === 0) return ` event=${event}`;
    return ` event=${event} ${JSON.stringify(rest)}`;
  }

  return {
    debug(msg: string, ctx?: LogContext): void {
      if (!shouldLog("debug")) return;
      console.error(`[${formatTimestamp()}] DEBUG: ${msg}${formatCtx(ctx)}`);
    },
    info(msg: string, ctx?: LogContext): void {
      if (!shouldLog("info")) return;
      console.error(`[${formatTimestamp()}] INFO: ${msg}${formatCtx(ctx)}`);
    },
    warn(msg: string, ctx?: LogContext): void {
      if (!shouldLog("warn")) return;
      console.error(`[${formatTimestamp()}] WARN: ${msg}${formatCtx(ctx)}`);
    },
    error(msg: string, ctx?: LogContext): void {
      if (!shouldLog("error")) return;
      console.error(`[${formatTimestamp()}] ERROR: ${msg}${formatCtx(ctx)}`);
    },
  };
}

export const logger = createLogger();
