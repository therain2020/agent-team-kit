import type { WriteLease } from "@kit/store";

/**
 * Defaults of the run-level single-writer lease (61 §3.5). A claim that is not
 * renewed within `staleMs` may be taken over; the owner renews every
 * `heartbeatMs`, which must stay below half the stale window so a single
 * missed beat never hands the run to a second worker.
 */
export const DEFAULT_RUN_LEASE_STALE_MS = 60_000;
export const DEFAULT_RUN_LEASE_HEARTBEAT_MS = 15_000;

/**
 * Raised in-process when the heartbeat proved this worker lost its claim. It
 * is not a fencing conflict from a write: it means the lease itself is gone,
 * so the worker must stop before the next stage or side effect.
 */
export class RunLeaseLostError extends Error {
  readonly code = "lease_lost";

  constructor(
    message: string,
    readonly requestId?: string,
    readonly leaseVersion?: number,
  ) {
    super(message);
    this.name = "RunLeaseLostError";
  }
}

/**
 * Validates the lease timing contract. A heartbeat at or above the stale
 * window lets an active worker be reclaimed, which is exactly the split-brain
 * double execution this lease exists to prevent.
 */
export function assertRunLeaseTimings(
  staleMs: number = DEFAULT_RUN_LEASE_STALE_MS,
  heartbeatMs: number = DEFAULT_RUN_LEASE_HEARTBEAT_MS,
): void {
  if (!(staleMs > 0) || !(heartbeatMs > 0)) {
    throw new Error("run lease requires positive staleMs and heartbeatMs");
  }
  if (heartbeatMs * 2 > staleMs) {
    throw new Error(
      `run lease heartbeat (${heartbeatMs}ms) must be at most half the stale window (${staleMs}ms)`,
    );
  }
}

/**
 * Process-local view of the claim the current worker is executing under
 * (61 §3.5 single-writer lease). The local runner sets it before invoking a
 * pipeline; activity writers picked it up here so every `runs`/`stages` write
 * carries the fencing token and a superseded worker updates 0 rows.
 *
 * Workflows executed outside a claim (Temporal worker, direct local calls)
 * leave it null and writes stay unconditional, as before.
 */
let activeLease: WriteLease | null = null;
let leaseLost: RunLeaseLostError | null = null;

export function setWriteLease(lease: WriteLease | null): void {
  activeLease = lease;
  leaseLost = null;
}

export function currentWriteLease(): WriteLease | null {
  return activeLease;
}

/** Options object for `RunStore.updateStatus` / `StageStore.updateStatus`. */
export function writeLeaseOptions(): { lease?: WriteLease } {
  return activeLease ? { lease: activeLease } : {};
}

/**
 * Marks the currently executing claim as lost. Called by the heartbeat when a
 * fenced renewal fails, so every in-flight activity can refuse to continue.
 */
export function markWriteLeaseLost(
  error: RunLeaseLostError | string,
): RunLeaseLostError {
  const lost = typeof error === "string" ? new RunLeaseLostError(error) : error;
  if (activeLease) {
    leaseLost = lost;
  }
  return lost;
}

export function currentWriteLeaseLost(): RunLeaseLostError | null {
  return leaseLost;
}

/**
 * Guard called at the top of every effectful activity. A worker whose lease
 * was superseded throws before it can execute another real side effect; the
 * new owner takes over from the durable journal.
 */
export function assertWriteLeaseActive(): void {
  if (leaseLost) {
    throw leaseLost;
  }
}

/** Runs `fn` with the given lease active, restoring the previous one after. */
export async function withWriteLease<T>(
  lease: WriteLease | null,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = activeLease;
  const previousLost = leaseLost;
  activeLease = lease;
  leaseLost = null;
  try {
    return await fn();
  } finally {
    activeLease = previous;
    leaseLost = previousLost;
  }
}
