/**
 * Review Execution Lock
 * 
 * Prevents concurrent execution of sampling/direct_api modes.
 * Orchestration mode is exempt (no external calls).
 * Includes TTL to prevent deadlocks on crash.
 */

import { logger } from "../utils/logger.js";

const LOCK_TTL_MS = 300_000; // 5 minutes

interface LockEntry {
  mode: string;
  acquiredAt: number;
}

let reviewLock: LockEntry | null = null;

export function acquireReviewLock(mode: string): boolean {
  if (reviewLock) {
    if (Date.now() - reviewLock.acquiredAt > LOCK_TTL_MS) {
      logger.warn("Lock TTL expired, overriding lock", {
        event: "lock_ttl_override",
        previousMode: reviewLock.mode,
        newMode: mode,
        lockAge: Date.now() - reviewLock.acquiredAt,
      });
      reviewLock = { mode, acquiredAt: Date.now() };
      return true;
    }
    return false;
  }
  reviewLock = { mode, acquiredAt: Date.now() };
  return true;
}

export function releaseReviewLock(): void {
  reviewLock = null;
}

export function getReviewLock(): LockEntry | null {
  if (reviewLock && Date.now() - reviewLock.acquiredAt > LOCK_TTL_MS) {
    reviewLock = null;
  }
  return reviewLock;
}

export function isLocked(): boolean {
  if (reviewLock && Date.now() - reviewLock.acquiredAt > LOCK_TTL_MS) {
    reviewLock = null;
    return false;
  }
  return reviewLock !== null;
}
