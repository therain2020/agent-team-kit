import type { RunMode, RunStatus, StageStatus } from "@kit/core";
import type { WorldSnapshot } from "@kit/store";

export type FactoryRisk = "low" | "medium" | "high";

export type FactoryRequestType =
  | "stage_before"
  | "stage_after"
  | "gate_failure"
  | "budget_exceeded";

export type FactoryStationId =
  | "demand"
  | "build"
  | "qa"
  | "gatekeeper"
  | "deliver";

export interface FactoryItem {
  kind: "approval" | "failed";
  requestId?: string;
  runId: string;
  workflowId?: string;
  stageId?: string;
  stageName?: string;
  requestType?: FactoryRequestType;
  stationId?: FactoryStationId;
  riskClass: FactoryRisk;
  summary: string;
  costCny: number;
  updatedAt: string;
  expiresAt?: string;
  artifactCount?: number;
  requestedBy?: string;
  /**
   * Producer resolved from the draft (or newest) artifact manifest (97 §3.5).
   * Absent means "unknown": the UI falls back to the generic sprite and never
   * guesses an owner.
   */
  producerAgentId?: string;
}

/** Door plate summary the office reads from the factory snapshot (97 §3.5). */
export interface FactoryLinkItem {
  requestId?: string;
  runId: string;
  summary: string;
  riskClass: FactoryRisk;
  producerAgentId?: string;
}

export interface FactoryLink {
  /** Queued approvals; the office factory door plate shows this number. */
  pendingCount: number;
  /** First few queued approvals, in gate order, for the door tooltip. */
  topItems: FactoryLinkItem[];
  generatedAt: string;
}

export interface FactoryStation {
  id: FactoryStationId;
  kind: "gate" | "review" | "deliver";
  count: number;
}

export interface FactorySnapshot {
  items: FactoryItem[];
  stations: FactoryStation[];
  generatedAt: string;
}

export interface FactoryDiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface FactoryDiff {
  available: boolean;
  reason?: "no-draft" | "unavailable";
  draftArtifactId?: string;
  truncated: boolean;
  parts: FactoryDiffPart[];
}

export interface FactoryGateEvidence {
  stageId: string;
  attempt: number;
  pass: boolean;
  scores: Record<string, number>;
  thresholds: Record<string, number>;
  rationale: string;
  summary: string;
  judgeModel: string;
  costCny: number;
}

export interface FactoryArtifactEvidence {
  artifactId: string;
  version: number;
  stageId: string;
  kind: string;
  createdAt: string;
  costCny: number;
  tokens: number;
  size: number;
}

export interface FactoryStageEvidence {
  stageId: string;
  name: string;
  status: StageStatus;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Approvals-entity facts the drawer needs beyond the run projection. */
export interface FactoryApprovalInfo {
  requestId: string;
  kind: string;
  requestType?: FactoryRequestType;
  assignee: string | null;
  /** CAS version of the approvals entity, sent back on takeover. */
  version: number;
  budget: { spentCny: number; limitCny: number | null } | null;
}

export interface FactoryEvidenceRef {
  artifactId: string;
  version: number;
  stageId: string;
  relation: string;
}

export interface FactoryHistoryEntry {
  decisionId?: string;
  requestId?: string;
  option: string;
  note: string;
  decidedBy: string;
  createdAt: string;
  batchId?: string;
  riskClass?: FactoryRisk;
}

export interface FactoryDetail {
  kind: "approval" | "failed";
  runId: string;
  workflowId: string;
  status: RunStatus;
  runMode: RunMode;
  updatedAt: string;
  summary: {
    title: string;
    stageId?: string;
    stageName?: string;
    requestType?: FactoryRequestType;
    requestedBy?: string;
    riskClass: FactoryRisk;
    expiresAt?: string;
    costCny: number;
    tokens: number;
    artifactCount: number;
    gateCount: number;
  };
  diff: FactoryDiff;
  evidence: {
    gates: FactoryGateEvidence[];
    artifacts: FactoryArtifactEvidence[];
    stages: FactoryStageEvidence[];
    /** "Why": what produced and consumed the draft under review (#140). */
    ancestry: FactoryEvidenceRef[];
    costCny: number;
    tokens: number;
  };
  /** Null for failed runs; the approval entity only exists while queued. */
  approval: FactoryApprovalInfo | null;
  history: FactoryHistoryEntry[];
}

export interface BatchTarget {
  runId: string;
  requestId: string;
}

export type BatchValidation =
  | { ok: true; targets: BatchTarget[] }
  | { ok: false; error: "invalid" | "empty" | "too-large" };

export const MAX_BATCH_SIZE = 20;

const RISK_ORDER: Record<FactoryRisk, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const STATION_ORDER: FactoryStationId[] = [
  "demand",
  "build",
  "qa",
  "gatekeeper",
  "deliver",
];

const STATION_KIND: Record<FactoryStationId, FactoryStation["kind"]> = {
  demand: "review",
  build: "review",
  qa: "gate",
  gatekeeper: "gate",
  deliver: "deliver",
};

export function stationForApproval(
  requestType?: FactoryRequestType,
): FactoryStationId {
  switch (requestType) {
    case "stage_before":
      return "build";
    case "stage_after":
      return "qa";
    default:
      return "gatekeeper";
  }
}

export function stationsFor(items: FactoryItem[]): FactoryStation[] {
  const counts = new Map<FactoryStationId, number>();
  for (const item of items) {
    if (item.kind !== "approval") {
      continue;
    }
    const id = item.stationId ?? stationForApproval(item.requestType);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return STATION_ORDER.map((id) => ({
    id,
    kind: STATION_KIND[id],
    count: counts.get(id) ?? 0,
  }));
}

export function orderGateItems(items: FactoryItem[]): FactoryItem[] {
  return items
    .filter((item) => item.kind === "approval")
    .sort(
      (left, right) =>
        RISK_ORDER[left.riskClass] - RISK_ORDER[right.riskClass] ||
        left.updatedAt.localeCompare(right.updatedAt),
    );
}

export function lowRiskItems(items: FactoryItem[]): FactoryItem[] {
  return orderGateItems(items).filter((item) => item.riskClass === "low");
}

/**
 * Gate count: approval workpieces only, failed runs are not approvals. This is
 * the one aggregation shared by the factory gate strip, the office door plate
 * and the `/api/office` snapshot (97 §3.5).
 */
export function pendingCountOf(items: readonly FactoryItem[]): number {
  return items.reduce(
    (count, item) => (item.kind === "approval" ? count + 1 : count),
    0,
  );
}

const FACTORY_LINK_TOP_ITEMS = 3;

/** Projects a factory snapshot onto the office door plate payload. */
export function factoryLinkFrom(
  snapshot: FactorySnapshot,
  limit = FACTORY_LINK_TOP_ITEMS,
): FactoryLink {
  const gate = orderGateItems(snapshot.items);
  return {
    pendingCount: pendingCountOf(snapshot.items),
    topItems: gate.slice(0, Math.max(0, limit)).map((item) => ({
      ...(item.requestId ? { requestId: item.requestId } : {}),
      runId: item.runId,
      summary: item.summary,
      riskClass: item.riskClass,
      ...(item.producerAgentId
        ? { producerAgentId: item.producerAgentId }
        : {}),
    })),
    generatedAt: snapshot.generatedAt,
  };
}

/**
 * Live door plate count (97 §3.5): once the world projection is available it
 * wins over the snapshot, so an `approval.requested/decided` delta moves the
 * office plate and the factory gate within the same batch window. Top items
 * that no longer belong to a paused run are dropped; unknown runs stay.
 */
export function reconcileFactoryLink(
  link: FactoryLink,
  world: WorldSnapshot | null,
): FactoryLink {
  if (!world) {
    return link;
  }
  const byRun = new Map(world.runs.map((run) => [run.runId, run]));
  let changed = false;
  let pendingCount = 0;
  for (const run of world.runs) {
    if (run.status === "paused") {
      pendingCount += 1;
    }
  }
  const topItems = link.topItems.filter((item) => {
    const run = byRun.get(item.runId);
    if (!run || run.status === "paused") {
      return true;
    }
    changed = true;
    return false;
  });
  if (pendingCount === link.pendingCount && !changed) {
    return link;
  }
  return { ...link, pendingCount, topItems };
}

/**
 * Paused runs the line does not know about yet. `approval.requested` reaches
 * the client through the world stream before a new workpieces snapshot does,
 * so the caller refetches `/api/factory` when this is non-empty (97 §3.5).
 */
export function missingPausedRunIds(
  items: readonly FactoryItem[],
  world: WorldSnapshot | null,
): string[] {
  if (!world) {
    return [];
  }
  const known = new Set(items.map((item) => item.runId));
  return world.runs
    .filter((run) => run.status === "paused" && !known.has(run.runId))
    .map((run) => run.runId);
}

export interface ProducerArtifactRef {
  artifactId: string;
  createdAt: string;
  producerAgentId: string | null | undefined;
}

/**
 * Resolves the producer of an approval workpiece (97 §3.5): the draft artifact
 * first, otherwise the newest artifact that recorded a producer. Synthetic
 * `workflow` actors and blank ids are not agents, so they resolve to `null`
 * and the UI falls back instead of inventing an owner.
 */
export function producerAgentIdFromArtifacts(
  artifacts: readonly ProducerArtifactRef[],
  draftArtifactId?: string | null,
): string | null {
  if (draftArtifactId) {
    const draft = artifacts.find(
      (artifact) => artifact.artifactId === draftArtifactId,
    );
    const fromDraft = normalizeProducer(draft?.producerAgentId);
    if (fromDraft) {
      return fromDraft;
    }
  }
  let newest: ProducerArtifactRef | null = null;
  for (const artifact of artifacts) {
    if (!normalizeProducer(artifact.producerAgentId)) {
      continue;
    }
    if (!newest || artifact.createdAt.localeCompare(newest.createdAt) > 0) {
      newest = artifact;
    }
  }
  return normalizeProducer(newest?.producerAgentId);
}

function normalizeProducer(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "workflow") {
    return null;
  }
  return trimmed;
}

export function batchTargetsFor(items: FactoryItem[]): BatchTarget[] {
  return lowRiskItems(items)
    .slice(0, MAX_BATCH_SIZE)
    .flatMap((item) =>
      item.requestId ? [{ runId: item.runId, requestId: item.requestId }] : [],
    );
}

export function needsConfirmation(item: FactoryItem): boolean {
  return item.riskClass !== "low";
}

export function validateBatchInput(input: unknown): BatchValidation {
  const raw =
    typeof input === "object" && input !== null
      ? (input as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "empty" };
  }
  if (raw.length > MAX_BATCH_SIZE) {
    return { ok: false, error: "too-large" };
  }

  const seen = new Set<string>();
  const targets: BatchTarget[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: "invalid" };
    }
    const { runId, requestId } = entry as {
      runId?: unknown;
      requestId?: unknown;
    };
    if (
      typeof runId !== "string" ||
      runId.length === 0 ||
      typeof requestId !== "string" ||
      requestId.length === 0
    ) {
      return { ok: false, error: "invalid" };
    }
    const key = JSON.stringify([runId, requestId]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push({ runId, requestId });
  }

  if (targets.length === 0) {
    return { ok: false, error: "empty" };
  }
  return { ok: true, targets };
}
