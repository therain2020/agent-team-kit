import { type AutoApproveScope, newId } from "@kit/core";
import type { initStore } from "@kit/store";

type Store = Awaited<ReturnType<typeof initStore>>;

export interface DecisionRecord {
  decisionId: string;
  runId: string;
  option: string;
  note: string;
  decidedBy: string;
  createdAt: string;
  requestId?: string;
  batchId?: string;
  riskClass?: "low" | "medium" | "high";
  /** Auto-approval policy that decided (`policy:autopilot` decisions). */
  policyId?: string;
  /** Effective scope of the deciding policy; `all` is the only manual-capable one. */
  scope?: AutoApproveScope;
  /** Trigger that launched the job, when the run came from the trigger plane. */
  triggerId?: string;
  /** Why the policy decided the way it did (mirrors `note`). */
  rationale?: string;
}

export interface ApprovalRequestView {
  requestId: string;
  runId: string;
  stageId: string;
  stageName: string;
  requestType:
    | "stage_before"
    | "stage_after"
    | "gate_failure"
    | "budget_exceeded";
  draftArtifactId: string | null;
  draftVersion: number;
  summary: string;
  options: string[];
  riskClass: "low" | "medium" | "high";
  gateRefs: Array<{ artifactId: string; version: number }>;
  requestedBy: string;
  expiresAt: string;
  artifactId: string;
}

export interface DecisionDetails {
  requestId?: string;
  actor?: string;
  batchId?: string;
  riskClass?: "low" | "medium" | "high";
  policyId?: string;
  scope?: AutoApproveScope;
  triggerId?: string;
  rationale?: string;
}

export async function recordDecision(
  store: Store,
  runId: string,
  option: string,
  note: string,
  details: DecisionDetails = {},
): Promise<{ decision: DecisionRecord; artifactId: string }> {
  const allowed = new Set(["approve", "revise", "abort"]);
  if (!allowed.has(option)) {
    throw new Error(`invalid option: ${option}`);
  }

  const run = await store.runs.get(runId);
  if (!run) {
    throw new Error(`run not found: ${runId}`);
  }

  const decision: DecisionRecord = {
    decisionId: newId("dec"),
    runId,
    option,
    note,
    decidedBy: details.actor ?? "operator",
    createdAt: new Date().toISOString(),
    ...(details.requestId ? { requestId: details.requestId } : {}),
    batchId: details.batchId ?? newId("batch"),
    ...(details.riskClass ? { riskClass: details.riskClass } : {}),
    ...(details.policyId ? { policyId: details.policyId } : {}),
    ...(details.scope ? { scope: details.scope } : {}),
    ...(details.triggerId ? { triggerId: details.triggerId } : {}),
    ...(details.rationale ? { rationale: details.rationale } : {}),
  };

  // The table is the authoritative read path (local engine polling, duplicate
  // guards). The artifact stays for the UI and for pre-table installs.
  await store.decisions.record({
    decisionId: decision.decisionId,
    workspaceId: run.workspaceId,
    runId,
    requestId: decision.requestId ?? null,
    option,
    note,
    rationale: decision.rationale ?? null,
    decidedBy: decision.decidedBy,
    policyId: decision.policyId ?? null,
    scope: decision.scope ?? null,
    triggerId: decision.triggerId ?? null,
    batchId: decision.batchId ?? null,
    riskClass: decision.riskClass ?? null,
    createdAt: decision.createdAt,
  });

  const published = await store.artifactService.publish({
    workspaceId: run.workspaceId,
    content: new TextEncoder().encode(JSON.stringify(decision, null, 2)),
    producer: {
      agentId: "manager",
      agentVersion: "1.0.0",
      promptHash: "sha256:manager-decision",
      modelId: "none",
    },
    inputs: [],
    runId,
    stageId: `${runId}:manager-decision-${decision.decisionId}`,
    runMode: run.runMode,
    cost: { currency: "CNY", amount: 0, tokens: 0 },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });

  return { decision, artifactId: published.artifact.artifactId };
}

export async function findApprovalRequest(
  store: Store,
  runId: string,
): Promise<ApprovalRequestView | null> {
  const artifacts = await store.artifactStore.listByRun(runId);
  const candidates: Array<{
    artifactId: string;
    createdAt: string;
    content: Record<string, unknown>;
  }> = [];

  for (const artifact of artifacts) {
    const manifest = await store.manifests.get(artifact.manifestId);
    if (!manifest?.stageId.includes(":approval-request")) {
      continue;
    }
    const content = await readArtifactJson(store, artifact.blobId);
    if (!content) {
      continue;
    }
    candidates.push({
      artifactId: artifact.artifactId,
      createdAt: artifact.createdAt,
      content,
    });
  }

  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = candidates[0];
  if (!latest) {
    return null;
  }

  const content = latest.content;
  return {
    requestId: String(content.requestId ?? "unknown"),
    runId: String(content.runId ?? runId),
    stageId: String(content.stageId ?? ""),
    stageName: String(content.stageName ?? ""),
    requestType:
      content.requestType === "stage_before" ||
      content.requestType === "stage_after" ||
      content.requestType === "budget_exceeded"
        ? content.requestType
        : "gate_failure",
    draftArtifactId:
      typeof content.draftArtifactId === "string"
        ? content.draftArtifactId
        : null,
    draftVersion:
      typeof content.draftVersion === "number" ? content.draftVersion : 1,
    summary: typeof content.summary === "string" ? content.summary : "",
    options: Array.isArray(content.options)
      ? content.options.filter(
          (option): option is string => typeof option === "string",
        )
      : ["approve", "abort"],
    riskClass:
      content.riskClass === "low" ||
      content.riskClass === "medium" ||
      content.riskClass === "high"
        ? content.riskClass
        : "medium",
    gateRefs: Array.isArray(content.gateRefs)
      ? content.gateRefs.flatMap((ref) => {
          if (
            typeof ref === "object" &&
            ref !== null &&
            typeof (ref as { artifactId?: unknown }).artifactId === "string"
          ) {
            const value = ref as { artifactId: string; version?: unknown };
            return [
              {
                artifactId: value.artifactId,
                version: typeof value.version === "number" ? value.version : 1,
              },
            ];
          }
          return [];
        })
      : [],
    requestedBy:
      typeof content.requestedBy === "string" ? content.requestedBy : "manager",
    expiresAt: typeof content.expiresAt === "string" ? content.expiresAt : "",
    artifactId: latest.artifactId,
  };
}

export interface ApprovalRecordDecisionInput {
  runId: string;
  requestId: string;
  decision: "approve" | "abort";
  actor: string;
  note?: string;
  at?: string;
  batchId?: string;
}

export type ApprovalRecordDecision =
  | { ok: true; duplicate: boolean; batchId?: string }
  | { ok: false; status: number; error: string };

/**
 * CAS-backed transition of the approvals entity before the decision artifact
 * is written. Concurrent decisions race on `(approval_id, version)`: exactly
 * one wins, the loser gets a version conflict unless the decision artifact
 * already exists (idempotent replay of a completed decision).
 *
 * Runs that predate the approvals table have no row; there we keep the
 * artifact-only behaviour so legacy installs keep working.
 */
export async function decideApprovalRecord(
  store: Store,
  input: ApprovalRecordDecisionInput,
): Promise<ApprovalRecordDecision> {
  const record = await store.approvals.get(input.requestId);
  if (!record || record.runId !== input.runId) {
    const existing = await findDecisionForRequest(
      store,
      input.runId,
      input.requestId,
    );
    return {
      ok: true,
      duplicate: Boolean(existing),
      ...(existing?.batchId ? { batchId: existing.batchId } : {}),
    };
  }

  const existing = await findDecisionForRequest(
    store,
    input.runId,
    input.requestId,
  );
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      ...(existing.batchId ? { batchId: existing.batchId } : {}),
    };
  }

  const target = input.decision === "approve" ? "approved" : "rejected";
  const result = await store.approvals.decide({
    approvalId: record.approvalId,
    expectedVersion: record.version,
    status: target,
    decisionBy: input.actor,
    decisionReason: input.note || input.decision,
    ...(input.at ? { at: input.at } : {}),
  });
  if (result.ok) {
    return {
      ok: true,
      duplicate: false,
      ...(input.batchId ? { batchId: input.batchId } : {}),
    };
  }

  // A previous attempt flipped the row but died before writing the decision
  // artifact; let the caller finish that step instead of dead-ending the run.
  if (result.code === "not_pending" && result.current?.status === target) {
    return {
      ok: true,
      duplicate: false,
      ...(input.batchId ? { batchId: input.batchId } : {}),
    };
  }

  const raced = await findDecisionForRequest(
    store,
    input.runId,
    input.requestId,
  );
  if (raced) {
    return {
      ok: true,
      duplicate: true,
      ...(raced.batchId ? { batchId: raced.batchId } : {}),
    };
  }
  return {
    ok: false,
    status: 409,
    error:
      result.code === "not_pending"
        ? `approval is ${result.current?.status ?? "not pending"}`
        : "approval version conflict",
  };
}

export interface ApprovalBackfillResult {
  scanned: number;
  created: number;
  skipped: number;
}

/**
 * Materializes approval entities from runs that are paused on an approval
 * artifact. Idempotent: rows already materialized are skipped, so it is safe
 * to call on every tick and on the first inbox read after an upgrade.
 */
export async function backfillApprovals(
  store: Store,
  options: { workspaceId?: string; limit?: number } = {},
): Promise<ApprovalBackfillResult> {
  const paused = await store.runs.list({
    status: "paused",
    limit: options.limit ?? 100,
  });
  const result: ApprovalBackfillResult = { scanned: 0, created: 0, skipped: 0 };
  for (const run of paused) {
    if (options.workspaceId && run.workspaceId !== options.workspaceId) {
      continue;
    }
    result.scanned += 1;
    const approval = await findApprovalRequest(store, run.runId);
    if (!approval?.requestId) {
      result.skipped += 1;
      continue;
    }
    const existing = await store.approvals.get(approval.requestId);
    if (existing) {
      result.skipped += 1;
      continue;
    }
    await store.approvals.enqueue({
      approvalId: approval.requestId,
      workspaceId: run.workspaceId,
      runId: run.runId,
      stageId: approval.stageId || null,
      kind: approval.requestType,
      requester: approval.requestedBy,
      payloadRef: approval.artifactId,
      slaDueAt: approval.expiresAt || null,
      expiresAt: approval.expiresAt || null,
    });
    result.created += 1;
  }
  return result;
}

/**
 * Latest decision for a request. The table is read first; rows written before
 * the table existed still resolve through the decision artifacts.
 */
export async function findDecisionForRequest(
  store: Store,
  runId: string,
  requestId: string,
): Promise<DecisionRecord | null> {
  const persisted = await store.decisions.findByRequest(runId, requestId);
  if (persisted) {
    return {
      decisionId: persisted.decisionId,
      runId: persisted.runId,
      option: persisted.option,
      note: persisted.note,
      decidedBy: persisted.decidedBy,
      createdAt: persisted.createdAt,
      ...(persisted.requestId ? { requestId: persisted.requestId } : {}),
      ...(persisted.batchId ? { batchId: persisted.batchId } : {}),
      ...(isRiskClass(persisted.riskClass)
        ? { riskClass: persisted.riskClass }
        : {}),
      ...(persisted.policyId ? { policyId: persisted.policyId } : {}),
      ...(isScope(persisted.scope) ? { scope: persisted.scope } : {}),
      ...(persisted.triggerId ? { triggerId: persisted.triggerId } : {}),
      ...(persisted.rationale ? { rationale: persisted.rationale } : {}),
    };
  }

  const artifacts = await store.artifactStore.listByRun(runId);
  for (const artifact of artifacts) {
    const manifest = await store.manifests.get(artifact.manifestId);
    if (!manifest?.stageId.includes(":manager-decision-")) {
      continue;
    }
    const content = await readArtifactJson(store, artifact.blobId);
    if (content && content.requestId === requestId) {
      return content as unknown as DecisionRecord;
    }
  }
  return null;
}

function isRiskClass(value: string | null): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function isScope(value: string | null): value is AutoApproveScope {
  return value === "scheduled" || value === "all";
}

export async function readArtifactText(
  store: Store,
  blobId: string,
): Promise<string> {
  const blob = await store.blobs.findById(blobId);
  if (!blob) {
    return "";
  }
  const bytes = await store.blobClient.get(blob.storageKey);
  return new TextDecoder().decode(bytes);
}

export async function readArtifactJson(
  store: Store,
  blobId: string,
): Promise<Record<string, unknown> | null> {
  const blob = await store.blobs.findById(blobId);
  if (!blob) {
    return null;
  }

  const bytes = await store.blobClient.get(blob.storageKey);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}
