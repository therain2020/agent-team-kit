import {
  type PriorityClass,
  type Quota,
  priorityClassFor,
  quotaUtilization,
} from "@kit/core/quota";

/**
 * Pure capacity read-model helpers (60 §3.5, issue #21). Kept free of store and
 * Next imports so they can be unit tested directly. Import the quota leaf, not
 * the @kit/core barrel: this file sits in the client graph (#222).
 */

export const CAPACITY_WINDOW_MS = 60_000;
const WAIT_SAMPLE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CapacityRequestRow {
  requestId: string;
  workspaceId: string;
  status: string;
  createdAt: string;
  claimedAt: string | null;
  priority: PriorityClass;
}

export interface WorkspaceCapacity {
  queued: number;
  inFlight: number;
  /** Requests enqueued in the last minute (a proxy for rpm usage). */
  rpm: number;
}

export interface QueueCapacityMetrics {
  queueDepth: number;
  inFlight: number;
  waitP95Ms: number;
  maxWaitMs: number;
  byWorkspace: Record<string, WorkspaceCapacity>;
  byPriority: Record<PriorityClass, number>;
}

export interface QuotaCapacityView {
  workspaceId: string;
  provider: string;
  model: string;
  rpm: number | null;
  tpm: number | null;
  concurrency: number | null;
  overflow: "queue" | "reject";
  queueTimeoutMs: number;
  /** Usage from this process's queue rows, when measurable. */
  usage: { rpm: number | null; concurrency: number | null };
}

export interface CapacityOverview {
  workspaceId: string;
  generatedAt: string;
  queue: QueueCapacityMetrics;
  quotas: QuotaCapacityView[];
  /** True when no local queue rows exist; the view then shows configuration only. */
  empty: boolean;
}

export function parsePriority(payload: string): PriorityClass {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return priorityClassFor({
      priority: parsed.priority ?? parsed.tier,
      runMode: parsed.runMode,
    });
  } catch {
    return "P2";
  }
}

export function toCapacityRow(row: {
  request_id: string;
  workspace_id: string;
  status: string;
  created_at: string;
  claimed_at: string | null;
  payload: string;
}): CapacityRequestRow {
  return {
    requestId: row.request_id,
    workspaceId: row.workspace_id,
    status: row.status,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    priority: parsePriority(row.payload),
  };
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

export function summarizeCapacity(
  rows: readonly CapacityRequestRow[],
  now: number = Date.now(),
): QueueCapacityMetrics {
  const byPriority: Record<PriorityClass, number> = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };
  const byWorkspace: Record<string, WorkspaceCapacity> = {};
  const waits: number[] = [];
  let queueDepth = 0;
  let inFlight = 0;

  const workspace = (id: string): WorkspaceCapacity => {
    byWorkspace[id] ??= { queued: 0, inFlight: 0, rpm: 0 };
    return byWorkspace[id];
  };

  for (const row of rows) {
    const created = Date.parse(row.createdAt);
    const lane = workspace(row.workspaceId);
    if (Number.isFinite(created) && now - created <= CAPACITY_WINDOW_MS) {
      lane.rpm += 1;
    }
    if (row.status === "queued") {
      queueDepth += 1;
      lane.queued += 1;
      byPriority[row.priority] += 1;
    } else if (row.status === "claimed") {
      inFlight += 1;
      lane.inFlight += 1;
      byPriority[row.priority] += 1;
    }
    if (row.claimedAt) {
      const claimed = Date.parse(row.claimedAt);
      if (
        Number.isFinite(created) &&
        Number.isFinite(claimed) &&
        now - claimed <= WAIT_SAMPLE_WINDOW_MS
      ) {
        waits.push(Math.max(0, claimed - created));
      }
    }
  }

  return {
    queueDepth,
    inFlight,
    waitP95Ms: percentile(waits, 0.95),
    maxWaitMs: waits.reduce((max, wait) => Math.max(max, wait), 0),
    byWorkspace,
    byPriority,
  };
}

export function toQuotaView(
  quota: Quota,
  metrics?: QueueCapacityMetrics | undefined,
): QuotaCapacityView {
  const workspace =
    quota.workspaceId === "*"
      ? undefined
      : metrics?.byWorkspace[quota.workspaceId];
  const usage = workspace
    ? {
        rpm: workspace.rpm,
        concurrency: workspace.inFlight,
      }
    : { rpm: null, concurrency: null };
  return {
    workspaceId: quota.workspaceId,
    provider: quota.provider,
    model: quota.model,
    rpm: quota.rpm ?? null,
    tpm: quota.tpm ?? null,
    concurrency: quota.concurrency ?? null,
    overflow: quota.overflow,
    queueTimeoutMs: quota.queueTimeoutMs,
    usage,
  };
}

export function quotaPressure(
  quota: QuotaCapacityView,
  metrics: QueueCapacityMetrics,
): number | null {
  const usageRpm =
    quota.workspaceId === "*"
      ? Object.values(metrics.byWorkspace).reduce(
          (max, lane) => Math.max(max, lane.rpm),
          0,
        )
      : (metrics.byWorkspace[quota.workspaceId]?.rpm ?? 0);
  const utilization = quotaUtilization({
    rpm: usageRpm,
    tpm: 0,
    concurrency: 0,
    quota: {
      workspaceId: quota.workspaceId,
      provider: quota.provider,
      model: quota.model,
      ...(quota.rpm !== null ? { rpm: quota.rpm } : {}),
      ...(quota.tpm !== null ? { tpm: quota.tpm } : {}),
      ...(quota.concurrency !== null ? { concurrency: quota.concurrency } : {}),
      overflow: quota.overflow,
      queueTimeoutMs: quota.queueTimeoutMs,
    },
  });
  return utilization.rpm;
}
