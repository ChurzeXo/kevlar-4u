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

// ── Client Info Store ─────────────────────────────────────────────────────────

let clientInfo: { name: string; version?: string } | null = null;
let clientCapabilities: Record<string, unknown> | null = null;

export function setClientInfo(name: string, version?: string): void {
  clientInfo = { name: name.toLowerCase(), version };
}

export function setClientCapabilities(caps: Record<string, unknown> | null): void {
  clientCapabilities = caps;
}

// ── Individual Capability Checks ──────────────────────────────────────────────

export function isSamplingSupported(): boolean {
  if (process.env.KEVLAR_ENABLE_SAMPLING === "true") return true;

  // Primary: check client-declared MCP capabilities (spec §5.2)
  if (clientCapabilities?.sampling !== undefined) return true;

  return false;
}

export function isStructuredOutputSupported(): boolean {
  return clientCapabilities?.structuredOutput !== undefined;
}

/**
 * Detect if the host AI supports Task tool (for subagent dispatch)
 * Uses heuristic detection based on client name + capability negotiation
 */
export function isSubagentDispatchSupported(): boolean {
  // If explicitly enabled via env var, return true
  if (process.env.KEVLAR_ENABLE_SUBAGENT === "true") return true;

  // If client info is not available, cannot detect
  if (!clientInfo?.name) return false;

  // Heuristic detection based on known clients that support Task/subagent
  // NOTE: OpenCode supports Task tools, but actual capability depends on the
  // underlying model (e.g. DeepSeek cannot autonomously dispatch subagents).
  // OpenCode users must explicitly set KEVLAR_ENABLE_SUBAGENT=true to opt-in.
  const name = clientInfo.name.toLowerCase();
  if (name.includes("claude-code") || name.includes("cline")) return true;
  if (name.includes("workbuddy") || name.includes("cursor")) return true;

  // TODO: Add runtime detection in future (send test prompt to verify)
  return false;
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
