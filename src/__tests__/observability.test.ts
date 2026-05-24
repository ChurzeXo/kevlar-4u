import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getErrorInfo, withDuration, logger } from "../utils/observability.js";

describe("getErrorInfo", () => {
  it("extracts info from KevlarError-like objects", () => {
    const err = new Error("not found") as any;
    err.code = "FILE_NOT_FOUND";
    err.recoverable = false;

    const info = getErrorInfo(err);
    assert.equal(info.code, "FILE_NOT_FOUND");
    assert.equal(info.message, "not found");
    assert.equal(info.recoverable, false);
  });

  it("extracts details from KevlarError", () => {
    const err = new Error("bad") as any;
    err.code = "VALIDATION_ERROR";
    err.recoverable = true;
    err.details = { field: "name" };

    const info = getErrorInfo(err);
    assert.deepEqual(info.details, { field: "name" });
  });

  it("defaults to INTERNAL_ERROR for plain Error", () => {
    const info = getErrorInfo(new Error("oops"));
    assert.equal(info.code, "INTERNAL_ERROR");
    assert.equal(info.message, "oops");
    assert.equal(info.recoverable, false);
  });

  it("handles string errors", () => {
    const info = getErrorInfo("crash");
    assert.equal(info.code, "INTERNAL_ERROR");
    assert.equal(info.message, "crash");
    assert.equal(info.recoverable, false);
  });

  it("handles null", () => {
    const info = getErrorInfo(null);
    assert.equal(info.code, "INTERNAL_ERROR");
    assert.equal(info.message, "null");
    assert.equal(info.recoverable, false);
  });
});

describe("withDuration", () => {
  it("returns result and durationMs", async () => {
    const { result, durationMs } = await withDuration(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });

    assert.equal(result, 42);
    assert.ok(durationMs >= 5);
  });

  it("works with sync-like async functions", async () => {
    const { result } = await withDuration(async () => "done");
    assert.equal(result, "done");
  });
});

describe("re-exports", () => {
  it("re-exports logger from logger.ts", () => {
    assert.equal(typeof logger.info, "function");
  });
});
