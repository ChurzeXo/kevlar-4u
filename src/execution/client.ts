/**
 * MCP Client Capability Detection (MECP §1)
 *
 * Negotiates capabilities with the host client using a versioned schema
 * similar to HTTP content negotiation.
 */

// ── Capability Interfaces (MECP §1) ────────────────────────────────────────────

export interface CapabilityDetail {
  supported: boolean;
  version?: string;
}

export interface Capabilities {
  sampling: CapabilityDetail;
  structuredOutput: CapabilityDetail;
  vision: CapabilityDetail;
  toolCalling: CapabilityDetail;
}

// ── Sampling-Supported Clients ─────────────────────────────────────────────────

const SAMPLING_CLIENTS = new Set([
  "claude-ai",
  "cursor",
  "claude-code",
  "codebuddycn",
  "codebuddy",
  "workbuddy",
  "leader-bridge",
]);

const STRUCTURED_OUTPUT_CLIENTS = new Set([
  "claude-ai",
  "claude-code",
]);

// ── Client Info Store ─────────────────────────────────────────────────────────

let clientInfo: { name: string; version?: string } | null = null;

export function setClientInfo(name: string, version?: string): void {
  clientInfo = { name: name.toLowerCase(), version };
}

// ── Individual Capability Checks ──────────────────────────────────────────────

export function isSamplingSupported(clientName?: string): boolean {
  if (process.env.KEVLAR_ENABLE_SAMPLING === "true") return true;

  const name = clientName ?? clientInfo?.name;
  if (!name) return false;
  return SAMPLING_CLIENTS.has(name.toLowerCase());
}

export function isStructuredOutputSupported(clientName?: string): boolean {
  const name = clientName ?? clientInfo?.name;
  if (!name) return true; // most modern LLMs support JSON mode
  return STRUCTURED_OUTPUT_CLIENTS.has(name.toLowerCase());
}

export function getSamplingClientList(): string[] {
  return Array.from(SAMPLING_CLIENTS);
}

// ── Composite Capability Query (MECP §1) ──────────────────────────────────────

export function getCapabilities(): Capabilities {
  const sampling = isSamplingSupported();
  return {
    sampling: { supported: sampling },
    structuredOutput: { supported: isStructuredOutputSupported() },
    vision: { supported: false },
    toolCalling: { supported: true },
  };
}

export function getCapabilitiesSummary(): string {
  const caps = getCapabilities();
  const lines: string[] = [];
  if (caps.sampling.supported) lines.push("sampling");
  if (caps.structuredOutput.supported) lines.push("structured output");
  if (caps.toolCalling.supported) lines.push("tool calling");
  return lines.length > 0 ? lines.join(", ") : "none detected";
}
