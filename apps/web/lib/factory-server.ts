import { microToCny } from "@kit/core";
import { diffLines } from "diff";
import { loadInboxData } from "./approvals";
import {
  type FactoryApprovalInfo,
  type FactoryDetail,
  type FactoryDiffPart,
  type FactoryEvidenceRef,
  type FactoryHistoryEntry,
  type FactoryItem,
  type FactorySnapshot,
  stationForApproval,
  stationsFor,
} from "./factory";
import { loadApprovalWhy } from "./inbox";
import { type ArtifactView, loadArtifactContent, loadRunDetail } from "./runs";
import { ensureStoreSchema, getStore } from "./store";

/** Same default workspace the approval tower reads budgets from. */
const DEFAULT_WORKSPACE = "default";

const MAX_DETAIL_ARTIFACTS = 40;
const MAX_DIFF_PARTS = 500;
const MAX_DIFF_CHARS = 40_000;

export async function loadFactorySnapshot(): Promise<FactorySnapshot> {
  const data = await loadInboxData();
  const items: FactoryItem[] = [
    ...data.paused
      .filter((entry) => entry.approval)
      .map((entry) => {
        const requestType = entry.approval?.requestType;
        return {
          kind: "approval" as const,
          requestId: entry.approval?.requestId,
          runId: entry.run.runId,
          workflowId: entry.run.workflowId,
          stageId: entry.approval?.stageId,
          stageName: entry.approval?.stageName,
          requestType,
          stationId: stationForApproval(requestType),
          riskClass: entry.approval?.riskClass ?? "medium",
          summary: entry.approval?.summary ?? "",
          costCny: entry.costCny,
          updatedAt: entry.run.updatedAt,
          expiresAt: entry.approval?.expiresAt,
          requestedBy: entry.approval?.requestedBy,
        };
      }),
    ...data.failed.map((entry) => ({
      kind: "failed" as const,
      runId: entry.run.runId,
      workflowId: entry.run.workflowId,
      riskClass: "high" as const,
      summary: entry.reason,
      costCny: entry.costCny,
      updatedAt: entry.run.updatedAt,
      artifactCount: entry.artifactCount,
    })),
  ];

  return {
    items,
    stations: stationsFor(items),
    generatedAt: new Date().toISOString(),
  };
}

export async function loadFactoryDetail(
  runId: string,
): Promise<FactoryDetail | null> {
  const detail = await loadRunDetail(runId);
  if (!detail) {
    return null;
  }

  const approval = detail.approval;
  const failedReason =
    detail.stages.find((stage) => stage.error)?.error ?? "run failed";

  const draftView = approval
    ? [...detail.artifacts]
        .reverse()
        .find((view) => view.artifact.artifactId === approval.draftArtifactId)
    : undefined;

  const diff = await buildDiff(draftView, detail.artifacts);

  await ensureStoreSchema();
  const client = await getStore();
  const requestId = approval?.requestId;
  const [record, budgetRows, why] = await Promise.all([
    requestId ? client.approvals.get(requestId) : Promise.resolve(null),
    client.budgetService
      .listBudgets({
        workspaceId: DEFAULT_WORKSPACE,
        scope: "run",
        targetPrefix: detail.run.runId,
        limit: 20,
      })
      .catch(() => []),
    requestId
      ? loadApprovalWhy(requestId, client).catch(() => null)
      : Promise.resolve(null),
  ]);
  const budget = budgetRows.find((row) => row.targetKey === detail.run.runId);
  const approvalInfo: FactoryApprovalInfo | null = requestId
    ? {
        requestId,
        kind: record?.kind ?? approval?.requestType ?? "gate_failure",
        ...(approval?.requestType ? { requestType: approval.requestType } : {}),
        assignee: record?.assignee ?? null,
        version: record?.version ?? 1,
        budget: budget
          ? {
              spentCny: microToCny(budget.spentCnyMicro),
              limitCny:
                budget.limitCnyMicro === null
                  ? null
                  : microToCny(budget.limitCnyMicro),
            }
          : null,
      }
    : null;
  const ancestry: FactoryEvidenceRef[] = why
    ? [...why.producedBy, ...why.consumedBy].map((ref) => ({
        artifactId: ref.artifactId,
        version: ref.version,
        stageId: ref.stageId,
        relation: ref.relation,
      }))
    : [];

  const history = (
    await Promise.all(
      detail.decisions.map(async (view) => {
        const { text } = await loadArtifactContent(
          view.artifact,
          undefined,
          20_000,
        );
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          return toHistoryEntry(parsed, view.artifact.createdAt);
        } catch {
          return null;
        }
      }),
    )
  )
    .filter((entry): entry is FactoryHistoryEntry => entry !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return {
    kind: approval ? "approval" : "failed",
    runId: detail.run.runId,
    workflowId: detail.run.workflowId,
    status: detail.run.status,
    runMode: detail.run.runMode,
    updatedAt: detail.run.updatedAt,
    summary: {
      title: approval?.summary || failedReason,
      stageId: approval?.stageId,
      stageName: approval?.stageName,
      requestType: approval?.requestType,
      requestedBy: approval?.requestedBy,
      riskClass: approval?.riskClass ?? "high",
      expiresAt: approval?.expiresAt,
      costCny: detail.costCny,
      tokens: detail.tokens,
      artifactCount: detail.artifacts.length,
      gateCount: detail.gates.length,
    },
    diff,
    evidence: {
      gates: detail.gates,
      artifacts: detail.artifacts.slice(-MAX_DETAIL_ARTIFACTS).map((view) => ({
        artifactId: view.artifact.artifactId,
        version: view.artifact.version,
        stageId: view.manifest?.stageId ?? "unknown",
        kind: view.kind,
        createdAt: view.artifact.createdAt,
        costCny: view.manifest?.cost.amount ?? 0,
        tokens: view.manifest?.cost.tokens ?? 0,
        size: view.blob?.size ?? 0,
      })),
      stages: detail.stages.map((stage) => ({
        stageId: stage.stageId,
        name: stage.name,
        status: stage.status,
        ...(stage.error ? { error: stage.error } : {}),
        ...(stage.startedAt ? { startedAt: stage.startedAt } : {}),
        ...(stage.finishedAt ? { finishedAt: stage.finishedAt } : {}),
      })),
      ancestry,
      costCny: detail.costCny,
      tokens: detail.tokens,
    },
    approval: approvalInfo,
    history,
  };
}

async function buildDiff(
  draft: ArtifactView | undefined,
  artifacts: ArtifactView[],
): Promise<FactoryDetail["diff"]> {
  if (!draft) {
    return {
      available: false,
      reason: "no-draft",
      truncated: false,
      parts: [],
    };
  }

  const draftContent = await loadArtifactContent(
    draft.artifact,
    undefined,
    20_000,
  );
  if (draftContent.unavailable) {
    return {
      available: false,
      reason: "unavailable",
      draftArtifactId: draft.artifact.artifactId,
      truncated: false,
      parts: [],
    };
  }

  const input = draft.manifest?.inputs[0];
  const previous = input
    ? [...artifacts]
        .reverse()
        .find((view) => view.artifact.artifactId === input.artifactId)
    : undefined;

  if (!previous) {
    const capped = capParts([
      { value: draftContent.text, added: true as const },
    ]);
    return {
      available: true,
      draftArtifactId: draft.artifact.artifactId,
      truncated: capped.truncated || draftContent.truncated,
      parts: capped.parts,
    };
  }

  const before = await loadArtifactContent(
    previous.artifact,
    undefined,
    20_000,
  );
  if (before.unavailable) {
    const capped = capParts([
      { value: draftContent.text, added: true as const },
    ]);
    return {
      available: true,
      draftArtifactId: draft.artifact.artifactId,
      truncated: capped.truncated || draftContent.truncated,
      parts: capped.parts,
    };
  }

  const changes = diffLines(before.text, draftContent.text).map((change) => ({
    value: change.value,
    ...(change.added ? { added: true } : {}),
    ...(change.removed ? { removed: true } : {}),
  }));
  const capped = capParts(changes);
  return {
    available: true,
    draftArtifactId: draft.artifact.artifactId,
    truncated: capped.truncated || draftContent.truncated || before.truncated,
    parts: capped.parts,
  };
}

function capParts(parts: FactoryDiffPart[]): {
  parts: FactoryDiffPart[];
  truncated: boolean;
} {
  const capped: FactoryDiffPart[] = [];
  let chars = 0;
  for (const part of parts) {
    if (capped.length >= MAX_DIFF_PARTS) {
      return { parts: capped, truncated: true };
    }
    const remaining = MAX_DIFF_CHARS - chars;
    if (remaining <= 0) {
      return { parts: capped, truncated: true };
    }
    if (part.value.length > remaining) {
      capped.push({ ...part, value: part.value.slice(0, remaining) });
      return { parts: capped, truncated: true };
    }
    chars += part.value.length;
    capped.push(part);
  }
  return { parts: capped, truncated: false };
}

function toHistoryEntry(
  parsed: Record<string, unknown>,
  fallbackCreatedAt: string,
): FactoryHistoryEntry | null {
  if (typeof parsed.option !== "string") {
    return null;
  }
  return {
    ...(typeof parsed.decisionId === "string"
      ? { decisionId: parsed.decisionId }
      : {}),
    ...(typeof parsed.requestId === "string"
      ? { requestId: parsed.requestId }
      : {}),
    option: parsed.option,
    note: typeof parsed.note === "string" ? parsed.note : "",
    decidedBy:
      typeof parsed.decidedBy === "string" ? parsed.decidedBy : "unknown",
    createdAt:
      typeof parsed.createdAt === "string"
        ? parsed.createdAt
        : fallbackCreatedAt,
    ...(typeof parsed.batchId === "string" ? { batchId: parsed.batchId } : {}),
    ...(parsed.riskClass === "low" ||
    parsed.riskClass === "medium" ||
    parsed.riskClass === "high"
      ? { riskClass: parsed.riskClass }
      : {}),
  };
}
