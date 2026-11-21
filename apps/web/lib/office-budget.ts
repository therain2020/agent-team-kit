/**
 * Query budget for the office snapshot (97 §5).
 *
 * `/office` and `GET /api/office` must stay well under the console budget even
 * on a busy workspace, so the loader never walks more than 12 runs and never
 * reads more than 60 artifact manifests per snapshot. Mission-assignment
 * content is only parsed for the most recent run. The rules live here as pure
 * functions so the limits are unit-tested independently of the store.
 */

export const OFFICE_RUN_LIMIT = 12;
export const OFFICE_MANIFEST_LIMIT = 60;

/** Newest-first runs owned by this Pack, capped to the snapshot budget. */
export function selectOfficeRuns<T extends { workflowId: string }>(
  runs: readonly T[],
  workflowIds: ReadonlySet<string>,
  limit: number = OFFICE_RUN_LIMIT,
): T[] {
  const picked: T[] = [];
  for (const run of runs) {
    if (!workflowIds.has(run.workflowId)) {
      continue;
    }
    picked.push(run);
    if (picked.length >= limit) {
      break;
    }
  }
  return picked;
}

/**
 * Counts distinct manifest reads across a snapshot. Re-claiming an id that was
 * already read is free (the loader caches it); a new id past the limit is
 * refused, so a single run with hundreds of artifacts cannot blow the budget.
 */
export class ManifestBudget {
  private readonly claimed = new Set<string>();

  constructor(private readonly limit: number = OFFICE_MANIFEST_LIMIT) {}

  claim(manifestId: string): boolean {
    if (this.claimed.has(manifestId)) {
      return true;
    }
    if (this.claimed.size >= this.limit) {
      return false;
    }
    this.claimed.add(manifestId);
    return true;
  }

  get size(): number {
    return this.claimed.size;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.claimed.size);
  }
}
