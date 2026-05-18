/**
 * Review Execution Lock
 * 
 * Prevents concurrent execution of sampling/direct_api modes.
 * Orchestration mode is exempt (no external calls).
 */

let reviewLock: { mode: string; startedAt: number } | null = null;

export function acquireReviewLock(mode: string): boolean {
  if (reviewLock) return false;
  reviewLock = { mode, startedAt: Date.now() };
  return true;
}

export function releaseReviewLock(): void {
  reviewLock = null;
}

export function getReviewLock(): { mode: string; startedAt: number } | null {
  return reviewLock;
}

export function isLocked(): boolean {
  return reviewLock !== null;
}
