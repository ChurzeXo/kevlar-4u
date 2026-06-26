import fs from "fs";

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

let _ttyFd: number | null | undefined;

function getTtyFd(): number | null {
  if (_ttyFd !== undefined) return _ttyFd;
  try {
    _ttyFd = fs.openSync("/dev/tty", "w");
  } catch {
    _ttyFd = null;
  }
  return _ttyFd;
}

function writeLog(line: string): void {
  process.stderr.write(line + "\n");
  const ttyFd = getTtyFd();
  if (ttyFd !== null) {
    try {
      fs.writeSync(ttyFd, line + "\n");
    } catch {
      _ttyFd = null;
    }
  }
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
      writeLog(`[${formatTimestamp()}] DEBUG: ${msg}${formatCtx(ctx)}`);
    },
    info(msg: string, ctx?: LogContext): void {
      if (!shouldLog("info")) return;
      writeLog(`[${formatTimestamp()}] INFO: ${msg}${formatCtx(ctx)}`);
    },
    warn(msg: string, ctx?: LogContext): void {
      if (!shouldLog("warn")) return;
      writeLog(`[${formatTimestamp()}] WARN: ${msg}${formatCtx(ctx)}`);
    },
    error(msg: string, ctx?: LogContext): void {
      if (!shouldLog("error")) return;
      writeLog(`[${formatTimestamp()}] ERROR: ${msg}${formatCtx(ctx)}`);
    },
  };
}

export const logger = createLogger();

export function writeRawStderr(line: string): void {
  writeLog(line);
}
