import { appendEvent, failIteration, updateRun } from "@kit/iteration";
import type { initStore } from "@kit/store";

type Store = Awaited<ReturnType<typeof initStore>>;

/**
 * Terminal states reported by the execution engine. "completed" is deliberately
 * not used to rewrite the projection: only the executor knows succeeded vs
 * partial, and it writes that itself.
 */
export type EngineRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "terminated"
  | "timed_out"
  | "continued_as_new"
  | "missing"
  | "unknown";

/**
 * `WorkflowNotFoundError` (or gRPC NOT_FOUND) is deterministic: the execution
 * does not exist, so the projection is stale. Other probe failures may be
 * transient (network, permissions) and must not rewrite the run.
 */
export function probeErrorStatus(error: unknown): EngineRunStatus {
  if (error instanceof Error && error.name === "WorkflowNotFoundError") {
    return "missing";
  }
  const code = (error as { cause?: { code?: number } } | undefined)?.cause
    ?.code;
  if (code === 5) {
    return "missing";
  }
  return "unknown";
}

export interface EngineProbe {
  describe(workflowId: string): Promise<EngineRunStatus>;
}

export interface ReconcileRunRow {
  iterationId: string;
  workspaceId: string;
  workflowId: string | null;
  status: string;
  updatedAt: string;
}

export type ReconcileTarget = "failed" | "cancelled";

export interface ReconcileDecision {
  row: ReconcileRunRow;
  engineStatus: EngineRunStatus;
  target: ReconcileTarget;
  reason: string;
}

export interface ReconcileOptions {
  store: Store;
  probe: EngineProbe;
  now?: () => Date;
  /** Only touch runs quiet for at least this long (default 5 minutes). */
  quietMs?: number;
  limit?: number;
}

export function reconcileTarget(
  status: EngineRunStatus,
): ReconcileTarget | null {
  switch (status) {
    case "failed":
    case "terminated":
    case "timed_out":
    case "missing":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

export async function decideReconciliations(
  rows: ReconcileRunRow[],
  probe: EngineProbe,
): Promise<ReconcileDecision[]> {
  const decisions: ReconcileDecision[] = [];
  for (const row of rows) {
    if (!row.workflowId) {
      continue;
    }
    let engineStatus: EngineRunStatus;
    try {
      engineStatus = await probe.describe(row.workflowId);
    } catch {
      continue;
    }
    const target = reconcileTarget(engineStatus);
    if (!target) {
      continue;
    }
    decisions.push({
      row,
      engineStatus,
      target,
      reason: `reconciled: engine workflow ${engineStatus} (${row.workflowId})`,
    });
  }
  return decisions;
}

/**
 * Converges iteration_runs whose executor is already terminal. Runs are the
 * projection; the engine is the fact. Quiet-window and cancelled protection
 * keep this from racing a live execution or overriding an operator action.
 */
export async function reconcileIterationRuns(
  options: ReconcileOptions,
): Promise<ReconcileDecision[]> {
  const now = options.now?.() ?? new Date();
  const cutoff = new Date(
    now.getTime() - (options.quietMs ?? 5 * 60_000),
  ).toISOString();
  const limit = options.limit ?? 50;
  const rows = await options.store.sql<ReconcileRunRow[]>`
    SELECT iteration_id AS "iterationId", workspace_id AS "workspaceId",
           workflow_id AS "workflowId", status, updated_at AS "updatedAt"
    FROM iteration_runs
    WHERE status IN ('running', 'paused')
      AND workflow_id IS NOT NULL
      AND updated_at < ${cutoff}
    ORDER BY updated_at ASC
    LIMIT ${limit}
  `;
  const decisions = await decideReconciliations(rows, options.probe);
  for (const decision of decisions) {
    await applyDecision(options.store, decision, now);
  }
  return decisions;
}

export interface LocalRunState {
  requestStatus: string | null;
  requestError?: string | null;
  requestHeartbeatAt: string | null;
}

export function reconcileLocalTarget(
  state: LocalRunState,
  options: { now: Date; staleMs?: number },
): { target: ReconcileTarget; reason: string } | null {
  if (!state.requestStatus) {
    return { target: "failed", reason: "reconciled: no queued request" };
  }
  if (state.requestStatus === "failed") {
    return {
      target: "failed",
      reason: `reconciled: local request failed${
        state.requestError ? ` (${state.requestError})` : ""
      }`,
    };
  }
  if (state.requestStatus === "cancelled") {
    return {
      target: "cancelled",
      reason: "reconciled: local request cancelled",
    };
  }
  if (state.requestStatus === "claimed") {
    const staleBefore = new Date(
      options.now.getTime() - (options.staleMs ?? 5 * 60_000),
    ).toISOString();
    if (!state.requestHeartbeatAt || state.requestHeartbeatAt < staleBefore) {
      return {
        target: "failed",
        reason: "reconciled: local runner heartbeat stale",
      };
    }
  }
  return null;
}

/**
 * Local counterpart: the run request is the engine. A claimed request with a
 * stale heartbeat means its executor is gone; queued requests are left alone so
 * a runner that starts later can still claim them.
 */
export async function reconcileLocalIterationRuns(
  options: Omit<ReconcileOptions, "probe">,
): Promise<ReconcileDecision[]> {
  const now = options.now?.() ?? new Date();
  const cutoff = new Date(
    now.getTime() - (options.quietMs ?? 5 * 60_000),
  ).toISOString();
  const limit = options.limit ?? 50;
  const rows = await options.store.sql<ReconcileRunRow[]>`
    SELECT iteration_id AS "iterationId", workspace_id AS "workspaceId",
           workflow_id AS "workflowId", status, updated_at AS "updatedAt"
    FROM iteration_runs
    WHERE status IN ('running', 'paused')
      AND updated_at < ${cutoff}
    ORDER BY updated_at ASC
    LIMIT ${limit}
  `;
  const decisions: ReconcileDecision[] = [];
  for (const row of rows) {
    const requests = await options.store.sql<
      Array<{
        status: string;
        error: string | null;
        heartbeatAt: string | null;
      }>
    >`
      SELECT status, error, heartbeat_at AS "heartbeatAt"
      FROM run_requests
      WHERE kind = 'iteration' AND run_id = ${row.iterationId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const request = requests[0];
    const target = reconcileLocalTarget(
      {
        requestStatus: request?.status ?? null,
        requestError: request?.error ?? null,
        requestHeartbeatAt: request?.heartbeatAt ?? null,
      },
      { now },
    );
    if (!target) {
      continue;
    }
    const decision: ReconcileDecision = {
      row,
      engineStatus: "unknown",
      target: target.target,
      reason: target.reason,
    };
    await applyDecision(options.store, decision, now);
    decisions.push(decision);
  }
  return decisions;
}

async function applyDecision(
  store: Store,
  decision: ReconcileDecision,
  now: Date,
): Promise<void> {
  const { row } = decision;
  if (decision.target === "cancelled") {
    await appendEvent(store, {
      iterationId: row.iterationId,
      kind: "run.cancelled",
      status: "cancelled",
      summary: decision.reason,
      payload: {
        reason: decision.reason,
        engineStatus: decision.engineStatus,
      },
    });
    await updateRun(store, row.iterationId, {
      status: "cancelled",
      phase: "cancelled",
      error: decision.reason,
      finishedAt: now.toISOString(),
    });
    return;
  }
  await failIteration(store, row.iterationId, decision.reason);
}
