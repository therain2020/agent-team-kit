import {
  type AgentState,
  type ProjectionStore,
  type RunProjection,
  loadAgentStateSnapshot,
  loadRunProjections,
} from "./projection";

/**
 * Shared world read model (87 §4.4, 97 §3.2).
 *
 * The console (`/api/world`) and the headless agent CLI (`kit agent world`)
 * must serve the exact same contract: the same TypeScript types, the same
 * `seq` semantics (the activity cursor) and the same ETag. Keeping the loader
 * here — next to the projection it reads — makes that sharing structural
 * instead of a convention two call sites have to remember.
 */
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

/** One streamed delta: the current projection row for every run a batch touched. */
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

export function worldEtag(seq: number): string {
  return `W/"world-${seq}"`;
}

/**
 * One row per run plus derived agent states. Two constant-cost indexed SELECTs
 * — the agent view doubles as the activity cursor — instead of a per-run N+1
 * assembly.
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
