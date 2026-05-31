import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import {
  ErrorCode,
  isKevlarError,
  getErrorMessage,
  formatErrorResponse,
} from "../utils/errors.js";
import { initI18n } from "../i18n/index.js";

before(async () => {
  await initI18n();
});

describe("ErrorCode", () => {
  it("has validation error codes", () => {
    assert.equal(ErrorCode.VALIDATION_ERROR, "VALIDATION_ERROR");
    assert.equal(ErrorCode.INVALID_INPUT, "INVALID_INPUT");
    assert.equal(ErrorCode.CONTENT_TOO_LONG, "CONTENT_TOO_LONG");
    assert.equal(ErrorCode.PERSONA_NOT_FOUND, "PERSONA_NOT_FOUND");
    assert.equal(ErrorCode.DUPLICATE_ID, "DUPLICATE_ID");
    assert.equal(ErrorCode.INVALID_ID_FORMAT, "INVALID_ID_FORMAT");
    assert.equal(ErrorCode.PATH_TRAVERSAL, "PATH_TRAVERSAL");
  });

  it("has resource error codes", () => {
    assert.equal(ErrorCode.FILE_NOT_FOUND, "FILE_NOT_FOUND");
    assert.equal(ErrorCode.FILE_READ_ERROR, "FILE_READ_ERROR");
    assert.equal(ErrorCode.FILE_WRITE_ERROR, "FILE_WRITE_ERROR");
    assert.equal(ErrorCode.PERMISSION_DENIED, "PERMISSION_DENIED");
  });

  it("has runtime error codes", () => {
    assert.equal(ErrorCode.INTERNAL_ERROR, "INTERNAL_ERROR");
    assert.equal(ErrorCode.UNKNOWN_TOOL, "UNKNOWN_TOOL");
  });
});

describe("isKevlarError", () => {
  it("returns true for KevlarError-like objects", () => {
    const err = new Error("test");
    (err as any).code = ErrorCode.VALIDATION_ERROR;
    (err as any).recoverable = false;
    assert.equal(isKevlarError(err), true);
  });

  it("returns false for plain Error", () => {
    assert.equal(isKevlarError(new Error("test")), false);
  });

  it("returns false for string", () => {
    assert.equal(isKevlarError("error"), false);
  });

  it("returns false for null", () => {
    assert.equal(isKevlarError(null), false);
  });

  it("returns false for object without code", () => {
    const err = new Error("test");
    (err as any).recoverable = false;
    assert.equal(isKevlarError(err), false);
  });

  it("returns false for object without recoverable", () => {
    const err = new Error("test");
    (err as any).code = ErrorCode.VALIDATION_ERROR;
    assert.equal(isKevlarError(err), false);
  });
});

describe("getErrorMessage", () => {
  it("returns message from Error instance", () => {
    assert.equal(getErrorMessage(new Error("hello")), "hello");
  });

  it("returns stringified value for non-Error", () => {
    assert.equal(getErrorMessage("raw string"), "raw string");
  });

  it("stringifies objects", () => {
    assert.equal(getErrorMessage({ foo: 1 }), "[object Object]");
  });
});

describe("formatErrorResponse", () => {
  it("formats KevlarError with code prefix", () => {
    const err = new Error("Not found") as any;
    err.code = ErrorCode.FILE_NOT_FOUND;
    err.recoverable = false;

    const result = formatErrorResponse(err);
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes(ErrorCode.FILE_NOT_FOUND));
    assert.ok(result.content[0].text.includes("Not found"));
  });

  it("formats regular Error with generic prefix", () => {
    const result = formatErrorResponse(new Error("Something broke"));
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("操作失败"));
    assert.ok(result.content[0].text.includes("Something broke"));
  });

  it("formats string fallback", () => {
    const result = formatErrorResponse("epic fail");
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("操作失败"));
    assert.ok(result.content[0].text.includes("epic fail"));
  });
});
