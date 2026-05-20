/**
 * MCP Client Capability Detection
 * 
 * Detects whether the connected MCP client supports sampling capabilities.
 */

// ── Sampling-Supported Clients ─────────────────────────────────────────────────

const SAMPLING_CLIENTS = new Set([
  "claude-ai",
  "cursor",
  "claude-code",
]);

// ── Client Info Store ─────────────────────────────────────────────────────────

let clientInfo: { name: string; version?: string } | null = null;

export function setClientInfo(name: string, version?: string): void {
  clientInfo = { name, version };
  // Normalize to lowercase for comparison
  clientInfo.name = name.toLowerCase();
}

// ── Capability Check ─────────────────────────────────────────────────────────

export function isSamplingSupported(clientName?: string): boolean {
  const name = clientName ?? clientInfo?.name;
  if (!name) return false;
  return SAMPLING_CLIENTS.has(name.toLowerCase());
}

export function getSamplingClientList(): string[] {
  return Array.from(SAMPLING_CLIENTS);
}
