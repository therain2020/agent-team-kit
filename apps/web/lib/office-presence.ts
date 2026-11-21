import type { ActivityEvent } from "@kit/activity";

/**
 * Pure office presence reducer (97 §3.2).
 *
 * The floor's live transport is the world stream (one SSE per tab, see
 * `world-client.ts`), but presence still has to be derivable from raw activity
 * events: the same fold backs replay (97 §7.1), snapshot reconciliation and
 * unit tests. Keeping it free of transport and React makes it reusable and
 * cheap to verify.
 *
 * Contract:
 * - `cursor` is the highest applied `event_id`; older events are dropped, so a
 *   replayed batch after a snapshot cannot roll state backwards.
 * - `runIds` scopes the fold to the current Pack; events for other runs are
 *   ignored (no cross-Pack bleed).
 * - workflow-level events (no `agentId`) only update the manager's supervision
 *   state, never a random agent.
 */

export type OfficePresenceStatus = "idle" | "working" | "blocked" | "error";

export interface OfficePresence {
  agentId: string;
  status: OfficePresenceStatus;
  /** Run the agent is currently tied to; `null` once idle. */
  runId: string | null;
  /** ISO timestamp of the event that produced the current state. */
  since: string;
}

export type RunPresenceState = "working" | "blocked" | "error";

export interface PresenceSnapshot {
  /** Highest applied activity cursor. */
  cursor: number;
  managerId: string;
  /** Runs the current Pack owns; empty means "do not scope". */
  runIds: string[];
  /** Live run map used to derive the manager's supervising state. */
  runs: Record<string, RunPresenceState>;
  agents: Record<string, OfficePresence>;
}

const EPOCH = "1970-01-01T00:00:00.000Z";

const WORKING_KINDS = new Set([
  "run.started",
  "stage.started",
  "stage.finished",
  "stage.reused",
  "model.turn",
  "tool.call",
  "tool.result",
  "coder.started",
  "coder.finished",
  "iteration.run.started",
  "iteration.plan",
  "iteration.coder.turn",
  "iteration.coder.tool",
  "iteration.coder.started",
  "iteration.coder.finished",
  "iteration.repair",
  "iteration.verify",
  "iteration.risk",
  "iteration.apply",
]);

const FAILED_KINDS = new Set([
  "run.failed",
  "stage.failed",
  "iteration.run.failed",
  "budget.exceeded",
  "ops.side_effect.blocked",
]);

const FINISHED_KINDS = new Set([
  "run.finished",
  "run.cancelled",
  "iteration.run.finished",
]);

const REJECTED_STATUSES = new Set([
  "abort",
  "aborted",
  "reject",
  "rejected",
  "deny",
  "denied",
  "cancel",
  "cancelled",
  "canceled",
]);

interface EventEffect {
  agentStatus?: OfficePresenceStatus;
  runState?: RunPresenceState;
  /** The run reached a terminal state; drop it from the supervising map. */
  clearRun?: boolean;
}

export function createPresenceSnapshot(
  managerId: string,
  agentIds: readonly string[],
  runIds: readonly string[] = [],
  since: string = EPOCH,
): PresenceSnapshot {
  const agents: Record<string, OfficePresence> = {};
  for (const agentId of new Set([...agentIds, managerId])) {
    agents[agentId] = { agentId, status: "idle", runId: null, since };
  }
  return {
    cursor: 0,
    managerId,
    runIds: [...new Set(runIds)],
    runs: {},
    agents,
  };
}

/** Replaces the Pack scope without mutating presence (snapshot resync). */
export function withRunScope(
  snapshot: PresenceSnapshot,
  runIds: readonly string[],
): PresenceSnapshot {
  return { ...snapshot, runIds: [...new Set(runIds)] };
}

/**
 * Folds one activity event into the presence snapshot. Returns the same
 * reference when nothing changed, so callers can bail out of renders cheaply.
 */
export function reducePresence(
  snapshot: PresenceSnapshot,
  event: ActivityEvent,
): PresenceSnapshot {
  if (!Number.isFinite(event.eventId) || event.eventId <= snapshot.cursor) {
    return snapshot;
  }
  if (
    event.runId &&
    snapshot.runIds.length > 0 &&
    !snapshot.runIds.includes(event.runId)
  ) {
    // Another Pack's run: do not apply and do not advance the cursor.
    return snapshot;
  }

  const effect = effectFor(event);
  if (!effect) {
    return { ...snapshot, cursor: event.eventId };
  }

  const agents = { ...snapshot.agents };
  let runs = { ...snapshot.runs };
  let changed = false;

  if (event.runId) {
    if (effect.runState) {
      runs[event.runId] = effect.runState;
      changed = true;
    } else if (effect.clearRun && runs[event.runId]) {
      delete runs[event.runId];
      changed = true;
    }
  }

  if (effect.agentStatus && event.agentId) {
    const current = agents[event.agentId];
    // Unknown agents belong to another Pack; the run map may still be ours.
    if (current) {
      const idle = effect.agentStatus === "idle";
      const nextRunId = idle
        ? null
        : effect.clearRun
          ? null
          : (event.runId ?? current.runId);
      if (
        current.status !== effect.agentStatus ||
        current.runId !== nextRunId
      ) {
        agents[event.agentId] = {
          ...current,
          status: effect.agentStatus,
          runId: nextRunId,
          since: event.createdAt,
        };
        changed = true;
      }
    }
  }

  const manager = deriveManager(
    agents,
    snapshot.managerId,
    runs,
    event.createdAt,
  );
  if (manager !== agents[snapshot.managerId]) {
    agents[snapshot.managerId] = manager;
    changed = true;
  }

  if (!changed && snapshot.cursor === event.eventId) {
    return snapshot;
  }
  return { ...snapshot, cursor: event.eventId, runs, agents };
}

export function reducePresenceBatch(
  snapshot: PresenceSnapshot,
  events: readonly ActivityEvent[],
): PresenceSnapshot {
  let next = snapshot;
  for (const event of events) {
    next = reducePresence(next, event);
  }
  return next;
}

function deriveManager(
  agents: Record<string, OfficePresence>,
  managerId: string,
  runs: Record<string, RunPresenceState>,
  at: string,
): OfficePresence {
  const current = agents[managerId] ?? {
    agentId: managerId,
    status: "idle" as const,
    runId: null,
    since: EPOCH,
  };
  const blockedRun = Object.entries(runs).find(
    ([, state]) => state === "blocked",
  );
  const workingRun = Object.entries(runs).find(
    ([, state]) => state === "working",
  );
  const target = blockedRun
    ? ({ status: "blocked", runId: blockedRun[0] } as const)
    : workingRun
      ? ({ status: "working", runId: workingRun[0] } as const)
      : ({ status: "idle", runId: null } as const);
  if (current.status === target.status && current.runId === target.runId) {
    return current;
  }
  return { ...current, status: target.status, runId: target.runId, since: at };
}

function effectFor(event: ActivityEvent): EventEffect | null {
  const kind = event.kind.toLowerCase();
  const status = (event.status ?? "").toLowerCase();

  if (FAILED_KINDS.has(kind) || status === "failed") {
    return { agentStatus: "error", runState: "error" };
  }
  if (FINISHED_KINDS.has(kind)) {
    return { agentStatus: "idle", clearRun: true };
  }
  if (kind === "approval.requested" || status === "paused") {
    return { agentStatus: "blocked", runState: "blocked" };
  }
  if (kind === "approval.decided") {
    return REJECTED_STATUSES.has(status)
      ? { agentStatus: "idle", clearRun: true }
      : { agentStatus: "working", runState: "working" };
  }
  if (WORKING_KINDS.has(kind)) {
    return { agentStatus: "working", runState: "working" };
  }
  return null;
}
