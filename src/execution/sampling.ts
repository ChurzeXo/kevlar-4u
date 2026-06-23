/**
 * Sampling Resolution Module
 *
 * Extracts the repetitive "check client + create samplingFn" pattern
 * from individual tool handlers into a single reusable function.
 *
 * Returns undefined if the connected MCP client does not support sampling,
 * otherwise returns a ready-to-use MultiTurnSamplingFunction.
 */

import { setClientInfo, isSamplingSupported } from "./client.js";
import { getSamplingClientList } from "./client.js";
import type { MultiTurnSamplingFunction } from "./base.js";
import { logger } from "../utils/logger.js";

export interface SamplingResolverDeps {
  /** Returns raw client version info from the MCP connection handshake. */
  getClientVersion: () => { name: string; version?: string } | undefined;
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
  if (!cv) {
    logger.debug("No client version info available, sampling disabled", { event: "sampling_no_client" });
    return undefined;
  }

  logger.debug("Resolving sampling support", {
    event: "sampling_resolve",
    clientName: cv.name,
    clientVersion: cv.version,
    knownClients: getSamplingClientList(),
  });

  setClientInfo(cv.name, cv.version);
  if (!isSamplingSupported(cv.name)) {
    logger.debug("Client not in sampling whitelist", {
      event: "sampling_not_whitelisted",
      clientName: cv.name,
    });
    return undefined;
  }

  return deps.createFn();
}
