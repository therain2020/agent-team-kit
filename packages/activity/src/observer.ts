import {
  type InformationEventRecord,
  type OpOrigin,
  type TriggerRunRecord,
  appendOp,
  type initStore,
  listOps,
} from "@kit/store";

/**
 * Observer plane read model and intervention audit (98 §3.5, issue #134).
 *
 * The observer is read-only by default: a timeline of information → reaction →
 * job → artifact, built from the existing information events and trigger runs
 * (no second event model). Interventions are the four audited powers
 * (`pause/kill/rollback/edit`) plus the high-risk `approve` review; every one
 * lands in the unified op log under `entity_kind = observer_action`, carrying
 * the actor, the reason and — for rollback — the reference it fell back to.
 */

type Store = Awaited<ReturnType<typeof initStore>>;

export const observerActionTypes = [
  "pause",
  "kill",
  "rollback",
  "edit",
  "approve",
] as const;

export type ObserverActionType = (typeof observerActionTypes)[number];

/**
 * Safety infrastructure is never editable through the observer plane
 * (98 §2 contract rule 6): recovery kernel, audit sink, LKG and the kill
 * switch itself. Rollback still targets LKG by reference, but `edit` may not.
 */
const PROTECTED_EDIT_TARGET =
  /^(recovery[-_ ]?kernel|recovery|audit[-_ ]?sink|audit[-_ ]?log|kill[-_ ]?switch|lkg)(:|\/|$)/i;

export class ObserverActionError extends Error {
  constructor(
    message: string,
    readonly code: "forbidden" | "invalid",
    readonly status: 400 | 403,
  ) {
    super(message);
    this.name = "ObserverActionError";
  }
}

export interface ObserverActionInput {
  actor: string;
  type: ObserverActionType;
  targetRef: string;
  reason: string;
  /** Rollback back-pointer: LKG id or artifact version the action restored. */
  reference?: string | null;
  workspaceId?: string;
  origin?: OpOrigin;
}

export interface ObserverActionRecord {
  actionId: string;
  seq: number;
  workspaceId: string;
  actor: string;
  type: ObserverActionType;
  targetRef: string;
  reason: string;
  reference: string | null;
  origin: OpOrigin;
  createdAt: string;
}

export interface ObserverTimelineReaction {
  triggerRunId: string;
  triggerId: string;
  ruleId: string;
  status: string;
  launchedAt: string;
  estimateCny: number;
  jobId: string | null;
  jobKind: string;
  lastError: string | null;
}

export interface ObserverTimelineEvent {
  eventId: string;
  eventType: string;
  sourceId: string;
  sourceKind: string;
  title: string;
  url: string;
  occurredAt: string;
  receivedAt: string;
  sensitivity: string;
}

export interface ObserverTimelineEntry {
  event: ObserverTimelineEvent;
  reaction: ObserverTimelineReaction | null;
}

export interface ObserverActionListQuery {
  workspaceId?: string;
  limit?: number;
}

export interface ObserverTimelineQuery {
  workspaceId?: string;
  limit?: number;
}

export interface ObserverMetricsQuery {
  workspaceId?: string;
  now?: string;
}

export interface ObserverMetrics {
  workspaceId: string;
  computedAt: string;
  actions24h: number;
  actions7d: number;
  actionsByType: Record<ObserverActionType, number>;
  reactions7d: number;
  failedReactions7d: number;
  /** Non-failed reactions over attempts; `null` when nothing ran. */
  reactionAccuracy: number | null;
  /** Interventions per reaction in the 7-day window; `null` without reactions. */
  interventionRate: number | null;
  gateApprovals7d: number;
  decidedGateApprovals7d: number;
  medianGateDecisionMinutes: number | null;
}

const OBSERVER_ACTION_KIND = "observer_action";

export function isObserverActionType(
  value: unknown,
): value is ObserverActionType {
  return (
    typeof value === "string" &&
    (observerActionTypes as readonly string[]).includes(value)
  );
}

/** True when an `edit` target is safety infrastructure and must stay immutable. */
export function isProtectedEditTarget(targetRef: string): boolean {
  return PROTECTED_EDIT_TARGET.test(targetRef.trim());
}

/** Validates an observer action before it is allowed to leave an audit trail. */
export function assertObserverActionAllowed(
  input: Pick<
    ObserverActionInput,
    "type" | "actor" | "reason" | "targetRef" | "reference"
  >,
): void {
  if (!isObserverActionType(input.type)) {
    throw new ObserverActionError(
      `forbidden observer action: ${String(input.type)}`,
      "forbidden",
      403,
    );
  }
  if (typeof input.actor !== "string" || input.actor.trim().length === 0) {
    throw new ObserverActionError("actor is required", "invalid", 400);
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new ObserverActionError("a reason is required", "invalid", 400);
  }
  if (
    typeof input.targetRef !== "string" ||
    input.targetRef.trim().length === 0
  ) {
    throw new ObserverActionError("targetRef is required", "invalid", 400);
  }
  if (input.type === "rollback") {
    if (typeof input.reference !== "string" || input.reference.trim() === "") {
      throw new ObserverActionError(
        "rollback requires a reference (LKG id or previous artifact version)",
        "invalid",
        400,
      );
    }
  }
  if (input.type === "edit" && isProtectedEditTarget(input.targetRef)) {
    throw new ObserverActionError(
      `${input.targetRef.trim()} is safety infrastructure and cannot be edited`,
      "forbidden",
      403,
    );
  }
}

/** Single writer for observer interventions; idempotent on the op log. */
export async function recordObserverAction(
  store: Store,
  input: ObserverActionInput,
): Promise<ObserverActionRecord> {
  assertObserverActionAllowed(input);
  const workspaceId = input.workspaceId ?? "default";
  const createdAt = new Date().toISOString();
  const targetRef = input.targetRef.trim();
  const reason = input.reason.trim().slice(0, 2000);
  const reference = input.reference?.trim() || null;
  const op = await appendOp(store, {
    workspaceId,
    entityKind: OBSERVER_ACTION_KIND,
    entityId: `${input.type}:${targetRef}`,
    op: `observer.${input.type}`,
    actor: input.actor.trim(),
    origin: input.origin ?? "web",
    payload: {
      type: input.type,
      actor: input.actor.trim(),
      targetRef,
      reason,
      reference,
    },
    createdAt,
  });
  return {
    actionId: op.opId,
    seq: op.seq,
    workspaceId: op.workspaceId,
    actor: op.actor,
    type: input.type,
    targetRef,
    reason,
    reference,
    origin: op.origin,
    createdAt: op.createdAt,
  };
}

/** Newest-first intervention ledger for the observer surface and CLI. */
export async function listObserverActions(
  store: Store,
  query: ObserverActionListQuery = {},
): Promise<ObserverActionRecord[]> {
  const limit = clampInt(query.limit, 1, 1000, 50);
  const ops = await listOps(store, {
    workspaceId: query.workspaceId ?? "default",
    entityKind: OBSERVER_ACTION_KIND,
    limit: 1000,
  });
  const actions: ObserverActionRecord[] = [];
  for (const op of ops) {
    const parsed = toObserverAction(op);
    if (parsed) {
      actions.push(parsed);
    }
  }
  return actions.sort((left, right) => right.seq - left.seq).slice(0, limit);
}

/**
 * Information → reaction → job timeline. The reaction side reads TriggerRuns of
 * kind `information`; a run links back to its event through `payloadRef` (the
 * I-3 contract) and, defensively, through a dedupe key that carries the event
 * id. Artifact links stay id-only and are rendered by the caller.
 */
export async function buildObserverTimeline(
  store: Store,
  query: ObserverTimelineQuery = {},
): Promise<ObserverTimelineEntry[]> {
  const workspaceId = query.workspaceId ?? "default";
  const limit = clampInt(query.limit, 1, 100, 20);
  const [events, runs] = await Promise.all([
    store.information.listEvents({ workspaceId, limit }),
    store.triggerRuns.list(workspaceId, { limit: Math.min(limit * 4, 500) }),
  ]);

  const reactionByEvent = new Map<string, ObserverTimelineReaction>();
  for (const run of runs) {
    if (run.kind !== "information") {
      continue;
    }
    const reaction = toTimelineReaction(run);
    if (run.payloadRef) {
      reactionByEvent.set(run.payloadRef, reaction);
    }
    const dedupeEvent = run.dedupeKey.split(":")[0];
    if (dedupeEvent && !reactionByEvent.has(dedupeEvent)) {
      reactionByEvent.set(dedupeEvent, reaction);
    }
  }

  return events.map((event) => ({
    event: toTimelineEvent(event),
    reaction: reactionByEvent.get(event.eventId) ?? null,
  }));
}

/**
 * Observer metrics (98 §5.1): regular-cycle intervention rate, reaction
 * accuracy and the median high-risk (gate) approval decision time. Proxies are
 * explicit: "accurate" means a reaction did not fail, not a human judgement.
 */
export async function summarizeObserverMetrics(
  store: Store,
  query: ObserverMetricsQuery = {},
): Promise<ObserverMetrics> {
  const workspaceId = query.workspaceId ?? "default";
  const now = query.now ? new Date(query.now) : new Date();
  const computedAt = now.toISOString();
  const since24 = now.getTime() - 24 * 60 * 60 * 1000;
  const since7 = now.getTime() - 7 * 24 * 60 * 60 * 1000;

  const [actions, runs, approvals] = await Promise.all([
    listObserverActions(store, { workspaceId, limit: 1000 }),
    store.triggerRuns.list(workspaceId, { limit: 5000 }),
    store.approvals.list({ workspaceId, limit: 200, sort: "created" }),
  ]);

  const actionsByType = Object.fromEntries(
    observerActionTypes.map((type) => [type, 0]),
  ) as Record<ObserverActionType, number>;
  let actions24h = 0;
  let actions7d = 0;
  for (const action of actions) {
    const at = Date.parse(action.createdAt);
    if (Number.isNaN(at) || at < since7) {
      continue;
    }
    actions7d += 1;
    actionsByType[action.type] += 1;
    if (at >= since24) {
      actions24h += 1;
    }
  }

  let reactions7d = 0;
  let failedReactions7d = 0;
  let successfulReactions7d = 0;
  for (const run of runs) {
    if (run.kind !== "information") {
      continue;
    }
    const at = Date.parse(run.launchedAt);
    if (Number.isNaN(at) || at < since7) {
      continue;
    }
    reactions7d += 1;
    if (run.status === "failed") {
      failedReactions7d += 1;
    } else if (run.status === "started" || run.status === "existing") {
      successfulReactions7d += 1;
    }
  }
  const measured = successfulReactions7d + failedReactions7d;
  const reactionAccuracy =
    measured > 0 ? successfulReactions7d / measured : null;
  const interventionRate = reactions7d > 0 ? actions7d / reactions7d : null;

  const gateApprovals7d = approvals.items.filter(
    (item) =>
      isGateApproval(item.kind) &&
      !Number.isNaN(Date.parse(item.createdAt)) &&
      Date.parse(item.createdAt) >= since7,
  );
  const decidedGate = gateApprovals7d.filter((item) => {
    if (item.status !== "approved" && item.status !== "rejected") {
      return false;
    }
    return (
      item.decisionAt !== null && !Number.isNaN(Date.parse(item.decisionAt))
    );
  });
  const durations = decidedGate
    .map(
      (item) =>
        (Date.parse(item.decisionAt ?? "") - Date.parse(item.createdAt)) /
        60000,
    )
    .filter((minutes) => Number.isFinite(minutes) && minutes >= 0);

  return {
    workspaceId,
    computedAt,
    actions24h,
    actions7d,
    actionsByType,
    reactions7d,
    failedReactions7d,
    reactionAccuracy,
    interventionRate,
    gateApprovals7d: gateApprovals7d.length,
    decidedGateApprovals7d: decidedGate.length,
    medianGateDecisionMinutes: median(durations),
  };
}

function toObserverAction(
  op: Awaited<ReturnType<typeof listOps>>[number],
): ObserverActionRecord | null {
  const payload =
    op.payload && typeof op.payload === "object"
      ? (op.payload as Record<string, unknown>)
      : {};
  const type = isObserverActionType(payload.type)
    ? payload.type
    : isObserverActionType(op.op.replace(/^observer\./, ""))
      ? (op.op.replace(/^observer\./, "") as ObserverActionType)
      : null;
  if (!type) {
    return null;
  }
  return {
    actionId: op.opId,
    seq: op.seq,
    workspaceId: op.workspaceId,
    actor: op.actor,
    type,
    targetRef: stringOr(payload.targetRef, op.entityId),
    reason: stringOr(payload.reason, ""),
    reference: stringOrNull(payload.reference),
    origin: op.origin,
    createdAt: op.createdAt,
  };
}

function toTimelineEvent(event: InformationEventRecord): ObserverTimelineEvent {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    sourceId: event.sourceId,
    sourceKind: event.sourceKind,
    title: event.title,
    url: event.url,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    sensitivity: event.sensitivity,
  };
}

function toTimelineReaction(run: TriggerRunRecord): ObserverTimelineReaction {
  return {
    triggerRunId: run.triggerRunId,
    triggerId: run.triggerId,
    ruleId: run.routeId,
    status: run.status,
    launchedAt: run.launchedAt,
    estimateCny: run.estimateCny,
    jobId: run.jobId,
    jobKind: run.jobKind,
    lastError: run.lastError,
  };
}

function isGateApproval(kind: string): boolean {
  return kind === "stage_before" || kind === "gate_failure";
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
