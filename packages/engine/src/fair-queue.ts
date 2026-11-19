import { type PriorityClass, priorityRank, priorityWeight } from "@kit/core";

/**
 * Workspace-weighted fair queue (60 §3.4, §5; issue #21).
 *
 * Within one workspace, items are served strictly by PriorityClass (P0 first,
 * then FIFO). Across workspaces, selection uses virtual finish time:
 * `virtualTime[ws] += 1 / weight[ws]` on every serve and the lowest virtual
 * time wins. A backlogged workspace therefore gets `weight` shares relative to
 * its peers, and one workspace's burst cannot starve another — the worst case
 * is bounded interleaving, not an unbounded wait.
 *
 * P0 items may preempt: `enqueue` puts P0 at the head of its workspace lane and
 * `preemptWith` jumps the whole queue (used for kill-switch/urgent events).
 */

export interface FairQueueItem<T> {
  id: string;
  workspaceId: string;
  priority: PriorityClass;
  enqueuedAt: number;
  payload: T;
}

export interface FairQueueOptions {
  /** Fallback workspace weight when no per-workspace value is configured. */
  defaultWeight?: number;
  /** Per-workspace weights; must be positive. */
  weights?: Record<string, number>;
}

export interface FairQueueSnapshot {
  depth: number;
  byWorkspace: Record<string, number>;
  byPriority: Record<PriorityClass, number>;
  servedByWorkspace: Record<string, number>;
  servedByPriority: Record<PriorityClass, number>;
  /** p95 wait (ms) across items dequeued since the queue was created. */
  waitP95Ms: number;
  maxWaitMs: number;
  oldestWaitMs: number;
}

interface Lane<T> {
  items: FairQueueItem<T>[];
  virtualTime: number;
  weight: number;
  served: number;
}

export class WorkspaceFairQueue<T> {
  private readonly lanes = new Map<string, Lane<T>>();
  private readonly preempted: FairQueueItem<T>[] = [];
  private readonly waits: number[] = [];
  private readonly servedByPriority: Record<PriorityClass, number> = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };
  private readonly defaultWeight: number;
  private readonly weights: Record<string, number>;

  constructor(options: FairQueueOptions = {}) {
    this.defaultWeight =
      options.defaultWeight !== undefined && options.defaultWeight > 0
        ? options.defaultWeight
        : 1;
    this.weights = options.weights ?? {};
  }

  get size(): number {
    let total = this.preempted.length;
    for (const lane of this.lanes.values()) {
      total += lane.items.length;
    }
    return total;
  }

  enqueue(item: FairQueueItem<T>): void {
    const lane = this.laneFor(item.workspaceId);
    const index = lane.items.findIndex(
      (queued) =>
        item.priority === "P0" ||
        priorityRank(item.priority) < priorityRank(queued.priority),
    );
    if (index === -1) {
      lane.items.push(item);
    } else {
      lane.items.splice(index, 0, item);
    }
  }

  /** Urgent (P0-class) item that bypasses the workspace rotation once. */
  preemptWith(item: FairQueueItem<T>): void {
    this.preempted.push(item);
  }

  /** Removes a queued item by id; returns it when found. */
  remove(id: string): FairQueueItem<T> | null {
    const preemptIndex = this.preempted.findIndex((item) => item.id === id);
    if (preemptIndex !== -1) {
      return this.preempted.splice(preemptIndex, 1)[0] ?? null;
    }
    for (const lane of this.lanes.values()) {
      const index = lane.items.findIndex((item) => item.id === id);
      if (index !== -1) {
        return lane.items.splice(index, 1)[0] ?? null;
      }
    }
    return null;
  }

  dequeue(now = Date.now()): { item: FairQueueItem<T>; waitMs: number } | null {
    const preempted = this.preempted.shift();
    if (preempted) {
      return this.finishDequeue(preempted, now, null);
    }

    let chosen: Lane<T> | null = null;
    for (const lane of this.lanes.values()) {
      if (lane.items.length === 0) {
        continue;
      }
      if (
        chosen === null ||
        lane.virtualTime < chosen.virtualTime ||
        (lane.virtualTime === chosen.virtualTime &&
          (lane.items[0]?.enqueuedAt ?? 0) < (chosen.items[0]?.enqueuedAt ?? 0))
      ) {
        chosen = lane;
      }
    }
    const item = chosen?.items.shift();
    if (!chosen || !item) {
      return null;
    }
    return this.finishDequeue(item, now, chosen);
  }

  /** Remaining queue depth per workspace. */
  depthByWorkspace(): Record<string, number> {
    const depth: Record<string, number> = {};
    for (const [workspaceId, lane] of this.lanes) {
      if (lane.items.length > 0) {
        depth[workspaceId] = lane.items.length;
      }
    }
    return depth;
  }

  snapshot(now = Date.now()): FairQueueSnapshot {
    const byPriority: Record<PriorityClass, number> = {
      P0: 0,
      P1: 0,
      P2: 0,
      P3: 0,
    };
    const byWorkspace: Record<string, number> = {};
    let oldest = 0;
    let maxWait = 0;
    for (const item of this.preempted) {
      byPriority[item.priority] += 1;
      byWorkspace[item.workspaceId] = (byWorkspace[item.workspaceId] ?? 0) + 1;
      oldest = Math.max(oldest, now - item.enqueuedAt);
    }
    for (const [workspaceId, lane] of this.lanes) {
      if (lane.items.length === 0) {
        continue;
      }
      byWorkspace[workspaceId] =
        (byWorkspace[workspaceId] ?? 0) + lane.items.length;
      for (const item of lane.items) {
        byPriority[item.priority] += 1;
        const wait = now - item.enqueuedAt;
        oldest = Math.max(oldest, wait);
        maxWait = Math.max(maxWait, wait);
      }
    }
    const servedByWorkspace: Record<string, number> = {};
    for (const [workspaceId, lane] of this.lanes) {
      if (lane.served > 0) {
        servedByWorkspace[workspaceId] = lane.served;
      }
    }
    return {
      depth: this.size,
      byWorkspace,
      byPriority,
      servedByWorkspace,
      servedByPriority: { ...this.servedByPriority },
      waitP95Ms: percentile(this.waits, 0.95),
      maxWaitMs: Math.max(maxWait, maxOf(this.waits)),
      oldestWaitMs: oldest,
    };
  }

  private finishDequeue(
    item: FairQueueItem<T>,
    now: number,
    lane: Lane<T> | null,
  ): { item: FairQueueItem<T>; waitMs: number } {
    const waitMs = Math.max(0, now - item.enqueuedAt);
    this.waits.push(waitMs);
    if (this.waits.length > 1000) {
      this.waits.shift();
    }
    this.servedByPriority[item.priority] += 1;
    if (lane) {
      lane.served += 1;
      lane.virtualTime += 1 / (lane.weight * priorityWeight(item.priority));
    }
    return { item, waitMs };
  }

  private laneFor(workspaceId: string): Lane<T> {
    let lane = this.lanes.get(workspaceId);
    if (lane) {
      return lane;
    }
    // A new workspace joins at the current minimum virtual time so it neither
    // jumps the whole backlog nor waits behind it.
    let initial = 0;
    let first = true;
    for (const existing of this.lanes.values()) {
      initial = first
        ? existing.virtualTime
        : Math.min(initial, existing.virtualTime);
      first = false;
    }
    const configured = this.weights[workspaceId];
    lane = {
      items: [],
      virtualTime: initial,
      weight:
        configured !== undefined && configured > 0
          ? configured
          : this.defaultWeight,
      served: 0,
    };
    this.lanes.set(workspaceId, lane);
    return lane;
  }
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const clamped = Math.min(Math.max(p, 0), 1);
  const index = Math.min(
    sorted.length - 1,
    Math.floor(clamped * sorted.length),
  );
  return sorted[index] ?? 0;
}

function maxOf(values: readonly number[]): number {
  let max = 0;
  for (const value of values) {
    max = Math.max(max, value);
  }
  return max;
}
