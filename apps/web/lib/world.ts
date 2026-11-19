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
import { ensureStoreSchema, getStore } from "./store";

type Store = ReturnType<typeof getStore>;

export interface WorldSnapshot {
  runs: RunProjection[];
  agents: AgentState[];
  computedAt: string;
}

export interface WorldSnapshotResult {
  snapshot: WorldSnapshot;
  /** `MAX(activity_events.event_id)` at snapshot time; resume streams here. */
  seq: number;
  etag: string;
}

export interface WorldDelta {
  seq: number;
  runs: RunProjection[];
  agents: AgentState[];
  eventCount: number;
}

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
