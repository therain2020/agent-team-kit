/**
 * Client-safe derivations shared by the two approvals views (82 §3, 89 §3.1).
 *
 * The approvals surface renders the same queue twice — as an SLA tower and as
 * a pixel conveyor — so anything that decides "which approval is active next"
 * or "which view is open" must live in one tested place. Nothing here imports
 * the store, the network or React.
 */

import {
  type FactoryItem,
  type FactoryRequestType,
  stationForApproval,
} from "./factory";
import type { ApprovalTowerCard, TowerBucket } from "./inbox-shared";

/** The two ways to look at the queue; both are one switch apart. */
export type ApprovalsView = "queue" | "factory";

export const APPROVALS_VIEWS: readonly ApprovalsView[] = ["queue", "factory"];

/** Unknown or missing `?view=` values fall back to the SLA tower. */
export function parseApprovalsView(
  value: string | string[] | null | undefined,
): ApprovalsView {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "factory" ? "factory" : "queue";
}

/** One URL shape for deep links, redirects and the command palette. */
export function approvalsHref(
  view: ApprovalsView = "queue",
  requestId?: string | null,
): string {
  const params = new URLSearchParams();
  if (view === "factory") {
    params.set("view", "factory");
  }
  if (requestId) {
    params.set("request", requestId);
  }
  const query = params.toString();
  return query ? `/approvals?${query}` : "/approvals";
}

/**
 * Deep link from an office station's blocked agent to the first approval of
 * that run (97 §3.3 / 97.5). `/factory` is a legacy redirect to this shape.
 */
export function factoryRunHref(runId: string): string {
  const params = new URLSearchParams({ view: "factory", run: runId });
  return `/approvals?${params.toString()}`;
}

/**
 * The first approval of a run in the order the line would process it. The
 * caller passes the gate-ordered list, so "first" is the one a keyboard user
 * would reach first. Returns null when the run has no queued approval.
 */
export function firstRequestForRun(
  items: readonly FactoryItem[],
  runId: string | null | undefined,
): string | null {
  if (!runId) {
    return null;
  }
  const match = items.find(
    (item) =>
      item.kind === "approval" &&
      item.runId === runId &&
      Boolean(item.requestId),
  );
  return match?.requestId ?? null;
}

/** Keyboard order of the tower: overdue first, then soon, today, later. */
export function flattenTower(
  groups: readonly TowerBucket[],
): ApprovalTowerCard[] {
  return groups.flatMap((group) => group.cards);
}

export function requestIdsOf<T extends { requestId?: string | null }>(
  cards: readonly T[],
): string[] {
  return cards.flatMap((card) => (card.requestId ? [card.requestId] : []));
}

/**
 * Clamped move used by the tower: `j/k` stop at the ends instead of wrapping,
 * so the operator can feel the bottom of the queue.
 */
export function stepRequestId(
  ids: readonly string[],
  activeId: string | null,
  delta: number,
): string | null {
  if (ids.length === 0) {
    return null;
  }
  const index = activeId ? ids.indexOf(activeId) : -1;
  const next = Math.max(0, Math.min(ids.length - 1, index + delta));
  return ids[next] ?? null;
}

/**
 * Wrapping move used by the conveyor: the belt loops, and resting on an
 * unknown id starts at the first workpiece.
 */
export function cycleRequestId(
  ids: readonly string[],
  activeId: string | null,
  delta: number,
): string | null {
  if (ids.length === 0) {
    return null;
  }
  const index = activeId ? ids.indexOf(activeId) : -1;
  if (index < 0) {
    return ids[0] ?? null;
  }
  const next = (index + delta + ids.length) % ids.length;
  return ids[next] ?? null;
}

/** Resolves the deep-linked request against what the surface actually has. */
export function resolveInitialRequest(
  requestIds: readonly string[],
  requested: string | null | undefined,
): string | null {
  if (requested && requestIds.includes(requested)) {
    return requested;
  }
  return requestIds[0] ?? null;
}

export interface DecisionTarget {
  runId: string;
  requestId: string;
  /** CAS version of the approvals entity; null when the view has none. */
  version: number | null;
}

/**
 * Batch targets derived from tower cards. The queue view selects explicitly,
 * the factory view selects every low risk workpiece; both end up here so a
 * batch submission is identical regardless of which view started it.
 */
const REQUEST_TYPES: ReadonlySet<string> = new Set([
  "stage_before",
  "stage_after",
  "gate_failure",
  "budget_exceeded",
]);

/**
 * Projects a tower card onto the factory item shape so a queue selection can
 * open the shared drawer and reuse `needsConfirmation` without a second rule
 * for "is this a one-key approval".
 */
export function towerCardToItem(card: ApprovalTowerCard): FactoryItem {
  const requestType = REQUEST_TYPES.has(card.requestType)
    ? (card.requestType as FactoryRequestType)
    : undefined;
  return {
    kind: "approval",
    requestId: card.requestId,
    runId: card.runId,
    workflowId: card.workflowId,
    stageId: card.stageId,
    stageName: card.stageName,
    ...(requestType ? { requestType } : {}),
    stationId: stationForApproval(requestType),
    ...(card.changeId ? { changeId: card.changeId } : {}),
    ...(card.substrate ? { substrate: card.substrate } : {}),
    riskClass: card.riskClass,
    summary: card.summary,
    costCny: card.budget?.spentCny ?? 0,
    updatedAt: card.createdAt,
    ...(card.expiresAt ? { expiresAt: card.expiresAt } : {}),
    requestedBy: card.requester,
  };
}

export function towerBatchTargets(
  cards: readonly ApprovalTowerCard[],
): DecisionTarget[] {
  return cards.map((card) => ({
    runId: card.runId,
    requestId: card.requestId,
    version: card.version,
  }));
}
