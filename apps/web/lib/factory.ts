import type { RunMode, RunStatus, StageStatus } from "@kit/core";

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
