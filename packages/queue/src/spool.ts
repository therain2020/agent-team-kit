/**
 * Local event spool (plan 61 §3.2 "事件总线不可用" row, §5; 01 §2.2).
 *
 * This is a deliberately thin adapter: it buffers queue messages while the
 * event bus is unavailable and replays them, in order, once the bus returns.
 * It carries no business semantics — the caller supplies the `eventId` used
 * for dedupe and the P0–P3 priority used for the D-38 shedding policy.
 *
 * Guarantees:
 * - Order is the spool insertion order; replay walks it oldest first.
 * - Dedupe is keyed by `eventId` only: an event that is buffered twice or
 *   already delivered is never applied twice.
 * - The backlog is bounded. Under pressure P3 is shed first (D-38); P0/P1 are
 *   always retained and reported as an aggregate. When nothing may be shed
 *   the spool raises `SpoolBackpressureError` so the producer stops.
 * - Replay outside `LIVE` runs only through an explicit sandbox executor and
 *   never consumes the backlog, so drills have no real side effects.
 */

export const SPOOL_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type SpoolPriority = (typeof SPOOL_PRIORITIES)[number];

/** Default priority when the producer does not classify an event. */
export const DEFAULT_SPOOL_PRIORITY: SpoolPriority = "P2";

/** Mirrors the core `RunMode` union without adding a @kit/core dependency. */
export const SPOOL_RUN_MODES = [
  "LIVE",
  "DRY_RUN",
  "SHADOW",
  "REPLAY",
  "FORK",
  "BACKFILL",
] as const;
export type SpoolRunMode = (typeof SPOOL_RUN_MODES)[number];

export interface SpoolRecord {
  /** Storage-assigned ordering key; absent for records not yet persisted. */
  spoolId?: number;
  eventId: string;
  subject: string;
  priority: SpoolPriority;
  data: Uint8Array;
  workspaceId: string;
  enqueuedAt: string;
}

/**
 * Persistence port. The SQL implementation lives in `@kit/store`; tests and
 * embedded callers can use `MemorySpoolStore`. Implementations must only
 * return undelivered records from `listPending` and keep delivered rows
 * queryable through `has` / `isDelivered` so replay stays idempotent.
 */
export interface SpoolStore {
  /** Persist a record; returns false when `eventId` already exists. */
  append(record: SpoolRecord): Promise<boolean>;
  listPending(): Promise<SpoolRecord[]>;
  /** Remove pending records. Delivered rows are kept for dedupe history. */
  remove(eventIds: readonly string[]): Promise<number>;
  markDelivered(eventId: string, deliveredAt: string): Promise<boolean>;
  isDelivered(eventId: string): Promise<boolean>;
  /** True when the id is known at all, pending or delivered. */
  has(eventId: string): Promise<boolean>;
}

export interface SpoolAggregate {
  total: number;
  byPriority: Record<SpoolPriority, number>;
  oldestEnqueuedAt: string | null;
  /** Events shed from this spool instance, by priority. */
  dropped: Record<SpoolPriority, number>;
}

export interface SpoolEnqueueInput {
  eventId: string;
  subject: string;
  data: Uint8Array;
  priority?: SpoolPriority;
  workspaceId?: string;
}

export type SpoolEnqueueResult =
  | { status: "buffered"; eventId: string; evicted: string[] }
  | { status: "duplicate"; eventId: string }
  | {
      status: "dropped";
      eventId: string;
      priority: SpoolPriority;
      reason: "priority_shed";
    };

export interface BoundedEventSpoolOptions {
  store: SpoolStore;
  /** Maximum pending records before shedding / backpressure kicks in. */
  maxPending?: number;
  /** Priorities that may be shed under pressure. Defaults to P3 (D-38). */
  droppable?: readonly SpoolPriority[];
  /** Clock override for tests. */
  now?: () => string;
}

export const DEFAULT_MAX_SPOOL_PENDING = 10_000;
export const DEFAULT_DROPPABLE_PRIORITIES: readonly SpoolPriority[] = ["P3"];

const PRIORITY_RANK: Record<SpoolPriority, number> = Object.fromEntries(
  SPOOL_PRIORITIES.map((priority, index) => [priority, index]),
) as Record<SpoolPriority, number>;

export function isSpoolPriority(value: unknown): value is SpoolPriority {
  return (
    typeof value === "string" &&
    (SPOOL_PRIORITIES as readonly string[]).includes(value)
  );
}

export class SpoolBackpressureError extends Error {
  readonly code = "spool_backpressure";

  constructor(
    readonly aggregate: SpoolAggregate,
    message = `event spool is full (${aggregate.total} pending, nothing shedable); back off the producer`,
  ) {
    super(message);
    this.name = "SpoolBackpressureError";
  }
}

export type SpoolReplayErrorCode =
  | "non_live_requires_sandbox"
  | "unknown_run_mode";

export class SpoolReplayError extends Error {
  constructor(
    readonly code: SpoolReplayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SpoolReplayError";
  }
}

/**
 * Where replay effects land. `apply` may perform real side effects and is
 * only ever called for LIVE runs. Non-LIVE runs require `simulate`, which is
 * expected to be a sandbox/stub hook that records without side effects.
 */
export interface SpoolReplayTarget {
  apply(entry: SpoolRecord): Promise<void>;
  simulate?(entry: SpoolRecord): Promise<void>;
}

export interface SpoolReplayOptions {
  runMode: SpoolRunMode;
  /** Keep replaying after a failed entry. Defaults to stop-on-first-error. */
  continueOnError?: boolean;
  now?: () => string;
}

export interface SpoolReplayFailure {
  eventId: string;
  reason: string;
}

export interface SpoolReplayReport {
  runMode: SpoolRunMode;
  live: boolean;
  attempted: number;
  delivered: number;
  simulated: number;
  /** Already-delivered ids encountered (defensive event_id dedupe). */
  duplicates: number;
  failed: SpoolReplayFailure[];
  remaining: number;
}

/**
 * Bounded, priority-aware spool over a persistence port.
 *
 * Single-writer assumption: one spool instance owns a workspace's backlog.
 * The pending index is loaded once and then maintained in memory; the store
 * remains the source of truth after `load()`.
 */
export class BoundedEventSpool {
  private readonly store: SpoolStore;
  private readonly maxPending: number;
  private readonly droppable: ReadonlySet<SpoolPriority>;
  private readonly now: () => string;
  private pending: SpoolRecord[] | null = null;
  private mutation: Promise<unknown> = Promise.resolve();
  private readonly dropped: Record<SpoolPriority, number> = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };

  constructor(options: BoundedEventSpoolOptions) {
    if (
      options.maxPending !== undefined &&
      (!Number.isInteger(options.maxPending) || options.maxPending <= 0)
    ) {
      throw new RangeError("maxPending must be a positive integer");
    }
    this.store = options.store;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_SPOOL_PENDING;
    this.droppable = new Set(options.droppable ?? DEFAULT_DROPPABLE_PRIORITIES);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Load the persisted backlog. Safe to call more than once. */
  async load(): Promise<void> {
    this.pending = await this.store.listPending();
  }

  async enqueue(input: SpoolEnqueueInput): Promise<SpoolEnqueueResult> {
    const priority = input.priority ?? DEFAULT_SPOOL_PRIORITY;
    return this.serialize(async () => {
      await this.ensureLoaded();
      if (await this.store.has(input.eventId)) {
        return { status: "duplicate", eventId: input.eventId } as const;
      }

      const pending = this.pending as SpoolRecord[];
      const evicted: string[] = [];

      if (pending.length >= this.maxPending) {
        if (this.droppable.has(priority)) {
          this.dropped[priority] += 1;
          return {
            status: "dropped",
            eventId: input.eventId,
            priority,
            reason: "priority_shed",
          } as const;
        }

        const candidate = pending.find((entry) =>
          this.droppable.has(entry.priority),
        );
        if (!candidate) {
          throw new SpoolBackpressureError(await this.aggregateUnlocked());
        }

        await this.store.remove([candidate.eventId]);
        pending.splice(pending.indexOf(candidate), 1);
        this.dropped[candidate.priority] += 1;
        evicted.push(candidate.eventId);
      }

      const record: SpoolRecord = {
        eventId: input.eventId,
        subject: input.subject,
        priority,
        data: input.data,
        workspaceId: input.workspaceId ?? "default",
        enqueuedAt: this.now(),
      };
      const appended = await this.store.append(record);
      if (!appended) {
        return { status: "duplicate", eventId: input.eventId } as const;
      }
      this.pending?.push(record);
      return { status: "buffered", eventId: input.eventId, evicted } as const;
    });
  }

  /** Snapshot of the current backlog, ordered oldest first. */
  async snapshot(): Promise<SpoolRecord[]> {
    await this.ensureLoaded();
    return [...(this.pending as SpoolRecord[])];
  }

  async aggregate(): Promise<SpoolAggregate> {
    await this.ensureLoaded();
    return this.aggregateUnlocked();
  }

  /**
   * Replay the backlog through `target`.
   *
   * LIVE runs call `target.apply`, mark each entry delivered and then remove
   * it from the backlog. Non-LIVE runs call `target.simulate` and leave the
   * backlog and delivery history untouched so a drill can be repeated.
   */
  async replay(
    target: SpoolReplayTarget,
    options: SpoolReplayOptions,
  ): Promise<SpoolReplayReport> {
    if (!(SPOOL_RUN_MODES as readonly string[]).includes(options.runMode)) {
      throw new SpoolReplayError(
        "unknown_run_mode",
        `unknown run mode: ${String(options.runMode)}`,
      );
    }
    const live = options.runMode === "LIVE";
    if (!live && !target.simulate) {
      throw new SpoolReplayError(
        "non_live_requires_sandbox",
        `run mode ${options.runMode} requires a sandbox executor; refusing to replay with real effects`,
      );
    }

    return this.serialize(async () => {
      await this.ensureLoaded();
      const now = options.now ?? this.now;
      const report: SpoolReplayReport = {
        runMode: options.runMode,
        live,
        attempted: 0,
        delivered: 0,
        simulated: 0,
        duplicates: 0,
        failed: [],
        remaining: 0,
      };

      for (const entry of [...(this.pending as SpoolRecord[])]) {
        if (await this.store.isDelivered(entry.eventId)) {
          await this.store.remove([entry.eventId]);
          this.removeFromPending(entry.eventId);
          report.duplicates += 1;
          continue;
        }

        report.attempted += 1;
        try {
          if (live) {
            await target.apply(entry);
            await this.store.markDelivered(entry.eventId, now());
            await this.store.remove([entry.eventId]);
            this.removeFromPending(entry.eventId);
            report.delivered += 1;
          } else {
            await (target.simulate as (value: SpoolRecord) => Promise<void>)(
              entry,
            );
            report.simulated += 1;
          }
        } catch (error) {
          report.failed.push({
            eventId: entry.eventId,
            reason: error instanceof Error ? error.message : String(error),
          });
          if (!options.continueOnError) {
            break;
          }
        }
      }

      report.remaining = (this.pending as SpoolRecord[]).length;
      return report;
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = await this.store.listPending();
    }
  }

  private removeFromPending(eventId: string): void {
    const pending = this.pending as SpoolRecord[];
    const index = pending.findIndex((entry) => entry.eventId === eventId);
    if (index >= 0) {
      pending.splice(index, 1);
    }
  }

  private async aggregateUnlocked(): Promise<SpoolAggregate> {
    const pending = this.pending ?? [];
    const byPriority = Object.fromEntries(
      SPOOL_PRIORITIES.map((priority) => [priority, 0]),
    ) as Record<SpoolPriority, number>;
    for (const entry of pending) {
      byPriority[entry.priority] += 1;
    }
    const ordered = [...pending].sort(
      (left, right) =>
        Date.parse(left.enqueuedAt) - Date.parse(right.enqueuedAt) ||
        PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority],
    );
    return {
      total: pending.length,
      byPriority,
      oldestEnqueuedAt: ordered[0]?.enqueuedAt ?? null,
      dropped: { ...this.dropped },
    };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutation.then(operation, operation);
    this.mutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * In-memory port used by unit tests, drills and embedded callers without a
 * database. Delivery history is kept so replay dedupe matches the SQL store.
 */
export class MemorySpoolStore implements SpoolStore {
  private rows: SpoolRecord[] = [];
  private readonly delivered = new Map<string, string>();

  async append(record: SpoolRecord): Promise<boolean> {
    if (this.exists(record.eventId)) {
      return false;
    }
    this.rows.push({ ...record, data: record.data.slice() });
    return true;
  }

  async listPending(): Promise<SpoolRecord[]> {
    return this.rows.map((row) => ({ ...row, data: row.data.slice() }));
  }

  async remove(eventIds: readonly string[]): Promise<number> {
    const ids = new Set(eventIds);
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !ids.has(row.eventId));
    return before - this.rows.length;
  }

  async markDelivered(eventId: string, deliveredAt: string): Promise<boolean> {
    if (this.delivered.has(eventId)) {
      return false;
    }
    if (!this.rows.some((row) => row.eventId === eventId)) {
      return false;
    }
    this.delivered.set(eventId, deliveredAt);
    return true;
  }

  async isDelivered(eventId: string): Promise<boolean> {
    return this.delivered.has(eventId);
  }

  async has(eventId: string): Promise<boolean> {
    return this.exists(eventId);
  }

  deliveredAt(eventId: string): string | null {
    return this.delivered.get(eventId) ?? null;
  }

  private exists(eventId: string): boolean {
    return (
      this.delivered.has(eventId) ||
      this.rows.some((row) => row.eventId === eventId)
    );
  }
}
