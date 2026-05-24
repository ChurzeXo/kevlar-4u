import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { logger } from "../utils/logger.js";

describe("logger", () => {
  it("exports expected methods", () => {
    assert.equal(typeof logger.debug, "function");
    assert.equal(typeof logger.info, "function");
    assert.equal(typeof logger.warn, "function");
    assert.equal(typeof logger.error, "function");
  });

  it("writes INFO to stderr with message and event", () => {
    const lines: string[] = [];
    mock.method(process.stderr, "write", (buf: any) => {
      lines.push(String(buf));
      return true;
    });

    logger.info("hello world", { event: "test_event" });

    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.ok(line.includes("INFO"));
    assert.ok(line.includes("hello world"));
    assert.ok(line.includes("test_event"));
  });

  it("includes extra context keys", () => {
    const lines: string[] = [];
    mock.method(process.stderr, "write", (buf: any) => {
      lines.push(String(buf));
      return true;
    });

    logger.info("ctx", { event: "ev", foo: "bar", num: 42 });

    const line = lines[0];
    assert.ok(line.includes("bar"));
    assert.ok(line.includes("42"));
  });

  it("writes ERROR to stderr", () => {
    const lines: string[] = [];
    mock.method(process.stderr, "write", (buf: any) => {
      lines.push(String(buf));
      return true;
    });

    logger.error("fail");
    assert.ok(lines[0].includes("ERROR"));
    assert.ok(lines[0].includes("fail"));
  });

  it("writes WARN to stderr", () => {
    const lines: string[] = [];
    mock.method(process.stderr, "write", (buf: any) => {
      lines.push(String(buf));
      return true;
    });

    logger.warn("caution");
    assert.ok(lines[0].includes("WARN"));
    assert.ok(lines[0].includes("caution"));
  });
});
