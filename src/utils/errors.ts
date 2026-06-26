/**
 * Structured error types for Kevlar-4u
 */

import { formatLocalizedError } from "../i18n/errors-i18n.js";

export enum ErrorCode {
  // Validation errors (4xx)
  VALIDATION_ERROR = "VALIDATION_ERROR",
  INVALID_INPUT = "INVALID_INPUT",
  CONTENT_TOO_LONG = "CONTENT_TOO_LONG",
  TOO_MANY_PERSONAS = "TOO_MANY_PERSONAS",
  PERSONA_NOT_FOUND = "PERSONA_NOT_FOUND",
  DUPLICATE_ID = "DUPLICATE_ID",
  INVALID_ID_FORMAT = "INVALID_ID_FORMAT",
  PATH_TRAVERSAL = "PATH_TRAVERSAL",

  // Configuration errors
  CONFIG_ERROR = "CONFIG_ERROR",

  // Resource errors (5xx)
  FILE_NOT_FOUND = "FILE_NOT_FOUND",
  FILE_READ_ERROR = "FILE_READ_ERROR",
  FILE_WRITE_ERROR = "FILE_WRITE_ERROR",
  DIRECTORY_NOT_FOUND = "DIRECTORY_NOT_FOUND",
  PERMISSION_DENIED = "PERMISSION_DENIED",

  // Runtime errors
  INTERNAL_ERROR = "INTERNAL_ERROR",
  UNKNOWN_TOOL = "UNKNOWN_TOOL",
}

export interface KevlarError extends Error {
  code: ErrorCode;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

export function invalidInputError(message: string, details?: Record<string, unknown>): KevlarError {
  return Object.assign(new Error(message), {
    code: ErrorCode.INVALID_INPUT,
    recoverable: false,
    details,
  });
}

export function configError(message: string, details?: Record<string, unknown>): KevlarError {
  return Object.assign(new Error(message), {
    code: ErrorCode.CONFIG_ERROR,
    recoverable: false,
    details,
  });
}

export function internalError(message: string, details?: Record<string, unknown>): KevlarError {
  return Object.assign(new Error(message), {
    code: ErrorCode.INTERNAL_ERROR,
    recoverable: true,
    details,
  });
}

export function validationError(message: string, details?: Record<string, unknown>): KevlarError {
  return Object.assign(new Error(message), {
    code: ErrorCode.VALIDATION_ERROR,
    recoverable: false,
    details,
  });
}

export function isKevlarError(err: unknown): err is KevlarError {
  return err instanceof Error && "code" in err && "recoverable" in err;
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

import { ToolResult } from "./types.js";

export function formatErrorResponse(err: unknown): ToolResult {
  if (isKevlarError(err)) {
    return {
      content: [{ type: "text", text: `❌ [${err.code}] ${err.message}` }],
      isError: true,
    };
  }

  const message = getErrorMessage(err);
  return {
    content: [{ type: "text", text: `❌ ${formatLocalizedError("common", "operationFailed")}: ${message}` }],
    isError: true,
  };
}
