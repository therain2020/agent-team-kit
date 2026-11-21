import type { RunRequestRecord } from "@kit/store";
import { type FairQueueOptions, WorkspaceFairQueue } from "./fair-queue";

/**
 * Fair claim path for the local runner (60 §3.4, §5; issue #250).
 *
 * Before 60.6 the runner claimed strictly by `created_at`, which made the
 * workspace fair queue and the admission gate dead code: one workspace's burst
 * could starve every other workspace. This scheduler is the single claim
 * selector for the runner:
 *
 * - claimable rows are fetched from the store (`listClaimable`), which keeps
 *   `created_at` as the deterministic FIFO tie-break;
 * - the workspace queue orders them by priority within a lane and by weighted
 *   virtual time across lanes;
 * - P0 requests are routed through `preemptWith` so they jump the whole
 *   rotation, matching `decideAdmission`'s "P0 bypasses queue rotation".
 *
 * The store still owns the atomic transition (`claim`); when another worker
 * wins a race the scheduler simply tries the next item. Rows that stop being
 * claimable (claimed, finished, dropped) are pruned on every refresh.
 */
export interface FairClaimStore {
  runRequests: FairClaimSource;
}

/** Structural subset of `RunRequestStore` so tests can inject a fake. */
export interface FairClaimSource {
  listClaimable(
    now: Date,
    staleMs: number,
    limit?: number,
  ): Promise<RunRequestRecord[]>;
  claim(
    requestId: string,
    owner: string,
    now: Date,
    staleMs: number,
  ): Promise<RunRequestRecord | null>;
}

export class FairClaimScheduler {
  private readonly queue: WorkspaceFairQueue<RunRequestRecord>;
  private readonly known = new Set<string>();

  constructor(options: FairQueueOptions = {}) {
    this.queue = new WorkspaceFairQueue<RunRequestRecord>(options);
  }

  /** Claimable items currently tracked by the scheduler. */
  get size(): number {
    return this.known.size;
  }

  /**
   * Returns the next request under the fair policy, or null when nothing is
   * claimable. Each call refreshes from the store so enqueues and other
   * workers' claims are picked up without a TTL cache.
   */
  async claimNext(
    store: FairClaimStore,
    owner: string,
    now: Date,
    staleMs: number,
  ): Promise<RunRequestRecord | null> {
    const candidates = await store.runRequests.listClaimable(now, staleMs);
    this.refresh(candidates);

    for (;;) {
      const next = this.queue.dequeue(now.getTime());
      if (!next) {
        return null;
      }
      this.known.delete(next.item.id);
      const claimed = await store.runRequests.claim(
        next.item.id,
        owner,
        now,
        staleMs,
      );
      if (claimed) {
        return claimed;
      }
      // Another worker won the race; keep draining what we know about.
    }
  }

  private refresh(candidates: readonly RunRequestRecord[]): void {
    const claimableIds = new Set(candidates.map((item) => item.requestId));
    for (const id of [...this.known]) {
      if (!claimableIds.has(id)) {
        this.queue.remove(id);
        this.known.delete(id);
      }
    }
    for (const candidate of candidates) {
      if (this.known.has(candidate.requestId)) {
        continue;
      }
      this.known.add(candidate.requestId);
      const item = {
        id: candidate.requestId,
        workspaceId: candidate.workspaceId,
        priority: candidate.priority,
        enqueuedAt: enqueuedAt(candidate),
        payload: candidate,
      };
      if (candidate.priority === "P0") {
        this.queue.preemptWith(item);
      } else {
        this.queue.enqueue(item);
      }
    }
  }
}

function enqueuedAt(record: RunRequestRecord): number {
  const parsed = Date.parse(record.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}
