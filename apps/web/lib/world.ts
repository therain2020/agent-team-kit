import type { ActivityEvent } from "@kit/activity";
import {
  type AgentState,
  type ProjectionStore,
  type RunProjection,
  agentStateFromEvent,
  backfillRunProjections,
  loadAgentStateSnapshot,
  loadRunProjections,
} from "@kit/store";
import { toIso } from "./iteration-mapping";
import { ensureStoreSchema, getStore } from "./store";
import type {
  WorldDelta,
  WorldSnapshot,
  WorldSnapshotResult,
} from "./world-state";

type Store = ReturnType<typeof getStore>;

// Types live in a client-safe module so the console can share them with the
// `/api/world` payloads without importing the server read model.
export type { WorldDelta, WorldSnapshot, WorldSnapshotResult };

export interface WorldSnapshotOptions {
  workspaceId?: string;
  /** Only runs materialized after this cursor; full snapshot when absent. */
  since?: number;
  limit?: number;
}

/**
 * World read model (87 §4.4): one row per run plus derived agent states. Two
 * constant-cost indexed SELECTs — the agent view doubles as the activity
 * cursor — instead of the per-run N+1 assembly in the legacy loaders.
 *
 * The cursor is read before the projections: if an event commits in between,
 * the stream replays it (idempotent deltas) rather than skipping it.
 */
export async function loadWorldSnapshot(
  store: ProjectionStore,
  options: WorldSnapshotOptions = {},
): Promise<WorldSnapshotResult> {
  const workspaceId = options.workspaceId ?? "default";
  const { agents, seq } = await loadAgentStateSnapshot(store.sql, {
    workspaceId,
  });
  const runs = await loadRunProjections(store.sql, {
    workspaceId,
    ...(options.since !== undefined ? { since: options.since } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });

  return {
    snapshot: { runs, agents, computedAt: new Date().toISOString() },
    seq,
    etag: worldEtag(seq),
  };
}

/**
 * Builds one stream delta from a drained activity batch: the current
 * projection row for every run the batch touched plus the latest agent state
 * per agent in the batch. No client-side fold is required.
 */
export async function buildWorldDelta(
  store: ProjectionStore,
  workspaceId: string,
  events: ActivityEvent[],
): Promise<WorldDelta> {
  const runIds = [
    ...new Set(
      events
        .map((event) => event.runId)
        .filter((runId): runId is string => Boolean(runId)),
    ),
  ];
  const runs = runIds.length
    ? await loadRunProjections(store.sql, { workspaceId, runIds })
    : [];

  const agents = new Map<string, AgentState>();
  for (const event of events) {
    const state = agentStateFromEvent(event);
    if (state) {
      agents.set(state.agentId, state);
    }
  }

  return {
    seq: events.reduce((max, event) => Math.max(max, event.eventId), 0),
    runs,
    agents: [...agents.values()],
    eventCount: events.length,
  };
}

export function worldEtag(seq: number): string {
  return `W/"world-${seq}"`;
}

export type WorldRunKind = "run" | "iteration";

export interface WorldRunMeta {
  runId: string;
  kind: WorldRunKind;
  startedAt: string | null;
}

interface WorldRunMetaRow {
  run_id: string;
  kind: string;
  started_at: string | Date | null;
}

/**
 * Kind + start time for every known job, in one statement. `run_projection`
 * deliberately carries only activity-derived fields, so the world page joins
 * this single UNION on `runs` / `iteration_runs` to label rows and compute
 * elapsed time without falling back to per-run manifest queries.
 */
export async function loadWorldRunMetas(
  store: ProjectionStore,
  workspaceId = "default",
): Promise<WorldRunMeta[]> {
  const rows = await store.sql<WorldRunMetaRow[]>`
    SELECT run_id, 'run' AS kind, created_at AS started_at
    FROM runs
    WHERE workspace_id = ${workspaceId}
    UNION ALL
    SELECT iteration_id AS run_id, 'iteration' AS kind, started_at
    FROM iteration_runs
    WHERE workspace_id = ${workspaceId}
  `;
  return rows.map((row) => ({
    runId: row.run_id,
    kind: row.kind === "iteration" ? "iteration" : "run",
    startedAt: toIso(row.started_at),
  }));
}

let backfillPromise: Promise<void> | undefined;

/**
 * Materializes `run_projection` from existing runs once per web process, so
 * installs created before the projection existed serve a populated world
 * immediately. The same idempotent function backs CLI/worker backfills.
 */
export async function ensureWorldProjectionBackfill(): Promise<void> {
  backfillPromise ??= (async () => {
    await ensureStoreSchema();
    await backfillRunProjections(getStore());
  })().catch((error) => {
    console.error(
      `[world] projection backfill failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  await backfillPromise;
}
