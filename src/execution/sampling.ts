/**
 * Sampling Resolution Module
 *
 * Extracts the repetitive "check client + create samplingFn" pattern
 * from individual tool handlers into a single reusable function.
 *
 * Returns undefined if the connected MCP client does not support sampling,
 * otherwise returns a ready-to-use MultiTurnSamplingFunction.
 */

import { setClientInfo, setClientCapabilities, isSamplingSupported } from "./client.js";
import type { MultiTurnSamplingFunction } from "./base.js";

export interface SamplingResolverDeps {
  /** Returns raw client version info from the MCP connection handshake. */
  getClientVersion: () => { name: string; version?: string } | undefined;
  /** Returns client capabilities declared during MCP initialize. */
  getClientCapabilities: () => Record<string, unknown> | undefined;
  /** Factory that creates a MultiTurnSamplingFunction bound to the server instance. */
  createFn: () => MultiTurnSamplingFunction;
}

export function resolveSamplingFn(
  deps: SamplingResolverDeps
): MultiTurnSamplingFunction | undefined {
  if (process.env.KEVLAR_ENABLE_SAMPLING === "true") {
    return deps.createFn();
  }

  const cv = deps.getClientVersion();
  if (cv) {
    setClientInfo(cv.name, cv.version);
  }

  const caps = deps.getClientCapabilities();
  if (caps) {
    setClientCapabilities(caps);
  }

  if (!isSamplingSupported()) return undefined;

  return deps.createFn();
}
