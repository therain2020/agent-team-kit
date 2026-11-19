import type { WriteLease } from "@kit/store";

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

export function setWriteLease(lease: WriteLease | null): void {
  activeLease = lease;
}

export function currentWriteLease(): WriteLease | null {
  return activeLease;
}

/** Options object for `RunStore.updateStatus` / `StageStore.updateStatus`. */
export function writeLeaseOptions(): { lease?: WriteLease } {
  return activeLease ? { lease: activeLease } : {};
}

/** Runs `fn` with the given lease active, restoring the previous one after. */
export async function withWriteLease<T>(
  lease: WriteLease | null,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = activeLease;
  activeLease = lease;
  try {
    return await fn();
  } finally {
    activeLease = previous;
  }
}
