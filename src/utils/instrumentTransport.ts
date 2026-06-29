/**
 * Lightweight RPC message logging interceptor for StdioServerTransport.
 *
 * Hooks into the transport before server.connect() to dump all JSON-RPC
 * messages to stderr (where Claude Desktop / MCP host logs them).
 *
 * Protocol.js connect() saves any pre-existing transport.onmessage as a
 * passthrough, so we can pre-register it before connect() — no fragile
 * Proxy or defineProperty tricks needed.
 *
 * Enabled by: KEVLAR_DEBUG_RPC=1
 */

import { writeRawStderr } from "./logger.js";

const TRUNCATE_AT = 8000;

function truncate(msg: string): string {
  if (msg.length <= TRUNCATE_AT) return msg;
  return msg.slice(0, TRUNCATE_AT) + `... [TRUNCATED ${msg.length - TRUNCATE_AT} chars]`;
}

export function instrumentTransport(transport: any): void {
  if (process.env.KEVLAR_DEBUG_RPC !== "1") return;

  // ── Incoming ──
  // Pre-register onmessage; protocol.js connect() will capture and chain-call it
  // alongside the server's own handler, giving us a passthrough for every message.
  transport.onmessage = (message: unknown) => {
    writeRawStderr(`[RPC IN]  ${truncate(JSON.stringify(message))}`);
  };

  // ── Outgoing ──
  const originalSend = transport.send.bind(transport);
  transport.send = (message: unknown): Promise<void> => {
    writeRawStderr(`[RPC OUT] ${truncate(JSON.stringify(message))}`);
    return originalSend(message);
  };
}
