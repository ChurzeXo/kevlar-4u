#!/usr/bin/env node
/**
 * stdio-sniffer — transparent MCP proxy that logs all stdio frames to a file.
 *
 * Usage:
 *   node scripts/stdio-sniffer.mjs <real-command> [args...]
 *
 * Example (replace WorkBuddy's kevlar-4u binary path with this):
 *   node .../scripts/stdio-sniffer.mjs node .../dist/index.js
 *
 * Logs written to: /tmp/kevlar-stdio-<timestamp>.jsonl
 *
 * stdin  (WorkBuddy → kevlar-4u) → logged as [IN]
 * stdout (kevlar-4u → WorkBuddy) → logged as [OUT]
 * stderr passes through unchanged
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";

const LOG_DIR = process.env.KEVLAR_SNIFF_DIR || "/tmp";
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = `${LOG_DIR}/kevlar-stdio-${Date.now()}.jsonl`;

function log(direction, raw) {
  const line = raw.trim();
  if (!line) return;
  try {
    appendFileSync(LOG_FILE, `[${direction}] ${line}\n`);
  } catch {
    // ignore
  }
  process.stderr.write(`[SNIFF ${direction}] ${line.slice(0, 200)}${line.length > 200 ? "..." : ""}\n`);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("Usage: stdio-sniffer.mjs <command> [args...]\n");
  process.exit(1);
}

const child = spawn(args[0], args.slice(1), {
  stdio: ["pipe", "pipe", "inherit"],
});

process.stderr.write(`[sniffer] Proxying: ${args.join(" ")}\n`);
process.stderr.write(`[sniffer] Log: ${LOG_FILE}\n`);

// stdin: WorkBuddy → kevlar-4u
let stdinBuf = "";
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk.toString("utf-8");
  // MCP stdio uses newline-delimited JSON
  const lines = stdinBuf.split("\n");
  stdinBuf = lines.pop() || ""; // keep incomplete last line
  for (const line of lines) {
    log("IN", line);
  }
  child.stdin.write(chunk);
});
process.stdin.on("end", () => {
  if (stdinBuf.trim()) log("IN", stdinBuf);
  child.stdin.end();
});

// stdout: kevlar-4u → WorkBuddy
let stdoutBuf = "";
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf-8");
  const lines = stdoutBuf.split("\n");
  stdoutBuf = lines.pop() || "";
  for (const line of lines) {
    log("OUT", line);
  }
  process.stdout.write(chunk);
});

child.on("close", (code) => {
  if (stdoutBuf.trim()) log("OUT", stdoutBuf);
  process.stderr.write(`[sniffer] Child exited with code ${code}\n`);
  process.exit(code ?? 0);
});
