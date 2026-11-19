import type { AgentState, RunProjection } from "@kit/store";
import type { FactoryItem } from "./factory";

/**
 * Client-safe world state (97 §3.2, 97.6).
 *
 * Everything in this module is a pure function over the `/api/world` payloads
 * so the reducer can be unit tested without a browser or a database. The
 * network plumbing lives in `world-client.ts`; the server read model is
 * `lib/world.ts`. Types are shared with the server route.
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

export interface WorldDelta {
  seq: number;
  runs: RunProjection[];
  agents: AgentState[];
  eventCount: number;
}

/** Connection state shown next to the floor (97 §3.2). */
export type WorldConnectionStatus = "live" | "reconnecting" | "offline";

export interface WorldClientState {
  /** `null` until the first snapshot resolves. */
  world: WorldSnapshot | null;
  /** Highest applied activity cursor; the stream resumes from here. */
  seq: number;
  status: WorldConnectionStatus;
  /** Epoch ms of the last applied snapshot/delta, for "last updated X ago". */
  lastUpdatedAt: number | null;
  error: string | null;
}

export const initialWorldState: WorldClientState = {
  world: null,
  seq: 0,
  // "Connecting" is represented as reconnecting so the first paint never
  // claims the floor is offline before the snapshot request even starts.
  status: "reconnecting",
  lastUpdatedAt: null,
  error: null,
};

/** Office-facing presence derived from the projection (97 §3.2). */
export type PresenceStatus =
  | "idle"
  | "working"
  | "blocked"
  | "waiting-approval"
  | "error";

export interface Presence {
  status: PresenceStatus;
  /** ISO timestamp when this state began; animations show its duration. */
  since: string;
  runId: string | null;
  currentTool: string | null;
}

/**
 * Replaces the world with an authoritative snapshot. Used on first load and
 * whenever the client resyncs after `online`/visibility recovery.
 */
export function applyWorldSnapshot(
  state: WorldClientState,
  result: WorldSnapshotResult,
  now: number = Date.now(),
): WorldClientState {
  return {
    world: result.snapshot,
    // The snapshot cursor is authoritative: the stream resumes there and
    // replays anything newer, so rows are never skipped.
    seq: result.seq,
    status: state.status === "live" ? "live" : "reconnecting",
    lastUpdatedAt: now,
    error: null,
  };
}

/**
 * Folds one stream delta into the current world. Rows are merged by key and
 * order-sensitive fields only advance: a delta never overwrites a newer
 * projection row, so replayed frames are idempotent and the stream wins over
 * optimistic local edits.
 */
export function applyWorldDelta(
  state: WorldClientState,
  delta: WorldDelta,
  now: number = Date.now(),
): WorldClientState {
  if (!state.world) {
    // A delta before the snapshot should not happen (the client connects with
    // `after=<seq>` only once the snapshot resolved); keep it as the world so
    // a slow snapshot is never lost.
    return {
      world: {
        runs: sortRuns(delta.runs),
        agents: sortAgents(delta.agents),
        computedAt: new Date(now).toISOString(),
      },
      seq: Math.max(state.seq, delta.seq),
      status: state.status,
      lastUpdatedAt: now,
      error: null,
    };
  }

  return {
    world: {
      runs: mergeRuns(state.world.runs, delta.runs),
      agents: mergeAgents(state.world.agents, delta.agents),
      computedAt: new Date(now).toISOString(),
    },
    seq: Math.max(state.seq, delta.seq),
    status: state.status,
    lastUpdatedAt: now,
    error: null,
  };
}

export function mergeRuns(
  existing: readonly RunProjection[],
  incoming: readonly RunProjection[],
): RunProjection[] {
  const merged = new Map(existing.map((run) => [run.runId, run]));
  for (const run of incoming) {
    const current = merged.get(run.runId);
    if (!current || run.lastEventId >= current.lastEventId) {
      merged.set(run.runId, run);
    }
  }
  return sortRuns([...merged.values()]);
}

export function mergeAgents(
  existing: readonly AgentState[],
  incoming: readonly AgentState[],
): AgentState[] {
  const merged = new Map(existing.map((agent) => [agent.agentId, agent]));
  for (const agent of incoming) {
    const current = merged.get(agent.agentId);
    if (!current || agent.since >= current.since) {
      merged.set(agent.agentId, agent);
    }
  }
  return sortAgents([...merged.values()]);
}

function sortRuns(runs: RunProjection[]): RunProjection[] {
  return runs.sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.runId.localeCompare(right.runId),
  );
}

function sortAgents(agents: AgentState[]): AgentState[] {
  return agents.sort(
    (left, right) =>
      right.since.localeCompare(left.since) ||
      left.agentId.localeCompare(right.agentId),
  );
}

/**
 * Maps a projection agent state onto the four floor states. `state` is
 * `event.status ?? event.kind`, so both statuses and kinds are accepted.
 */
export function presenceStatus(state: string): PresenceStatus {
  const value = state.toLowerCase();
  if (value === "paused" || value === "blocked") {
    return "blocked";
  }
  if (
    value === "pending" ||
    value === "waiting" ||
    value.startsWith("approval.")
  ) {
    return "waiting-approval";
  }
  if (value === "failed" || value === "error") {
    return "error";
  }
  if (value === "running" || value === "started" || value === "working") {
    return "working";
  }
  if (
    value === "succeeded" ||
    value === "completed" ||
    value === "finished" ||
    value === "passed" ||
    value === "idle" ||
    value.startsWith("run.finished")
  ) {
    return "idle";
  }
  // Activity kinds without an explicit status still mean the agent is busy.
  if (
    value.startsWith("stage.") ||
    value.startsWith("model.") ||
    value.startsWith("tool.") ||
    value.startsWith("coder.") ||
    value.startsWith("gate.") ||
    value.startsWith("manager.")
  ) {
    return "working";
  }
  return "idle";
}

export function presenceFromAgentState(
  agent: AgentState | undefined,
): Presence | null {
  if (!agent) {
    return null;
  }
  return {
    status: presenceStatus(agent.state),
    since: agent.since,
    runId: agent.runId,
    currentTool: agent.currentTool,
  };
}

/**
 * Manager presence is derived from the projection of the runs the office
 * knows about: a paused run means the manager waits on a human, a running run
 * means supervision. `undefined` means "no signal", so callers keep the
 * server-rendered fallback instead of forcing the manager idle.
 */
export function managerPresence(
  world: WorldSnapshot | null,
  runIds: ReadonlySet<string>,
): Presence | null {
  if (!world || runIds.size === 0) {
    return null;
  }
  const active = world.runs.filter((run) => runIds.has(run.runId));
  const paused = active.find((run) => run.status === "paused");
  if (paused) {
    return {
      status: "waiting-approval",
      since: paused.updatedAt,
      runId: paused.runId,
      currentTool: null,
    };
  }
  const running = active.find((run) => run.status === "running");
  if (running) {
    return {
      status: "working",
      since: running.updatedAt,
      runId: running.runId,
      currentTool: null,
    };
  }
  return null;
}

/**
 * Applies the projection to the factory line: an approval item disappears as
 * soon as its run is no longer paused (the stream wins over the optimistic
 * removal), and cost/timestamp follow the projection instead of the stale
 * server snapshot. Returns the same reference when nothing changed so React
 * can bail out.
 */
export function reconcileFactoryItems(
  items: readonly FactoryItem[],
  world: WorldSnapshot | null,
): FactoryItem[] {
  if (!world) {
    return items as FactoryItem[];
  }
  const byRun = new Map(world.runs.map((run) => [run.runId, run]));
  let changed = false;
  const next: FactoryItem[] = [];
  for (const item of items) {
    const run = byRun.get(item.runId);
    if (!run) {
      next.push(item);
      continue;
    }
    if (item.kind === "approval" && run.status !== "paused") {
      changed = true;
      continue;
    }
    const costCny = roundCost(run.costCny);
    const updatedAt = run.updatedAt;
    const artifactCount = run.artifactCount;
    if (
      costCny !== roundCost(item.costCny) ||
      updatedAt !== item.updatedAt ||
      artifactCount !== item.artifactCount
    ) {
      changed = true;
      next.push({ ...item, costCny, updatedAt, artifactCount });
      continue;
    }
    next.push(item);
  }
  return changed ? next : (items as FactoryItem[]);
}

function roundCost(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0;
}

/** Exponential backoff with a cap; attempt 0 → 1s, capped at 30s. */
export function reconnectDelay(attempt: number, random = Math.random): number {
  const base = Math.min(1_000 * 2 ** Math.max(0, attempt), 30_000);
  // Jitter avoids reconnect storms when several tabs recover together.
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Short stage label (`plan:write` → `write`) used by the floor copy. */
export function shortStage(stageId: string | null | undefined): string {
  if (!stageId) {
    return "";
  }
  const parts = stageId.split(":");
  return parts[parts.length - 1] ?? stageId;
}
