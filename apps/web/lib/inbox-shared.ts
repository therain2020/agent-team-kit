/**
 * Client-safe inbox types and pure SLA grouping. Server loaders live in
 * `lib/inbox.ts`; keeping this module import-free means the tower bundle never
 * pulls in the store.
 */

export type ApprovalRiskClass = "low" | "medium" | "high";

export interface ApprovalGateScore {
  artifactId: string;
  pass: boolean | null;
  scores: Array<{
    dimension: string;
    value: number;
    threshold: number | null;
  }>;
  rationale: string;
}

export interface ApprovalBudgetImpact {
  spentCny: number;
  limitCny: number | null;
}

export interface ApprovalTowerCard {
  requestId: string;
  runId: string;
  /** Set when the request guards a ChangeProposal instead of a run. */
  changeId: string | null;
  /** ChangeProposal substrate (code/prompt/workflow/skill) for the label. */
  substrate: string | null;
  /** Rollback reference the proposal carries, shown as evidence. */
  revertRef: string | null;
  workflowId: string;
  stageId: string;
  stageName: string;
  kind: string;
  requestType: string;
  riskClass: ApprovalRiskClass;
  summary: string;
  requester: string;
  assignee: string | null;
  status: string;
  version: number;
  createdAt: string;
  /** SLA first, expiry second, creation last — matches the store ordering. */
  dueAt: string | null;
  expiresAt: string | null;
  draftArtifactId: string | null;
  draftSnippet: string;
  gate: ApprovalGateScore | null;
  budget: ApprovalBudgetImpact | null;
  runStatus: string | null;
}

export interface ApprovalTowerSnapshot {
  approvals: ApprovalTowerCard[];
  generatedAt: string;
  /** True when the queue exceeded the loader's page size. */
  truncated: boolean;
}

export type TowerBucketId = "overdue" | "soon" | "today" | "later";

export const TOWER_BUCKETS: readonly TowerBucketId[] = [
  "overdue",
  "soon",
  "today",
  "later",
];

export interface TowerBucket {
  id: TowerBucketId;
  cards: ApprovalTowerCard[];
  /** Queue depth: how many approvals sit in this column. */
  depth: number;
  /** Median age (ms) of the approvals in this column; null when empty. */
  medianWaitMs: number | null;
}

/**
 * Groups due-sorted approvals into SLA columns. Kept pure so the console can
 * re-bucket on every poll tick and the behaviour is testable without a store.
 */
export function groupApprovals(
  cards: ApprovalTowerCard[],
  now: number = Date.now(),
): TowerBucket[] {
  const dayEnd = startOfNextDay(now);
  const buckets: Record<TowerBucketId, ApprovalTowerCard[]> = {
    overdue: [],
    soon: [],
    today: [],
    later: [],
  };
  for (const card of cards) {
    buckets[bucketOf(card.dueAt, now, dayEnd)].push(card);
  }
  return TOWER_BUCKETS.map((id) => ({
    id,
    cards: buckets[id],
    depth: buckets[id].length,
    medianWaitMs: medianWait(buckets[id], now),
  }));
}

export function bucketOf(
  dueAt: string | null,
  now: number,
  dayEnd: number,
): TowerBucketId {
  if (!dueAt) {
    return "later";
  }
  const due = new Date(dueAt).getTime();
  if (!Number.isFinite(due)) {
    return "later";
  }
  if (due < now) {
    return "overdue";
  }
  if (due <= now + 30 * 60_000) {
    return "soon";
  }
  if (due < dayEnd) {
    return "today";
  }
  return "later";
}

export function medianWait(
  cards: ApprovalTowerCard[],
  now: number,
): number | null {
  if (cards.length === 0) {
    return null;
  }
  const waits = cards
    .map((card) => now - new Date(card.createdAt).getTime())
    .filter((wait) => Number.isFinite(wait))
    .map((wait) => Math.max(0, wait))
    .sort((left, right) => left - right);
  if (waits.length === 0) {
    return null;
  }
  const middle = Math.floor(waits.length / 2);
  return waits.length % 2 === 0
    ? Math.round(((waits[middle - 1] ?? 0) + (waits[middle] ?? 0)) / 2)
    : (waits[middle] ?? 0);
}

function startOfNextDay(now: number): number {
  const date = new Date(now);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}
