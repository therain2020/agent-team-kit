import type { ApprovalStatus } from "@kit/store";
import { cache } from "react";
import {
  type ApprovalApiItem,
  type ApprovalEntityView,
  toApiApprovalItem,
} from "./approval-mapping";
import type { ArtifactView, RunDetail } from "./runs";
import {
  loadArtifactContent,
  loadPausedRuns,
  loadRunDetail,
  loadRunSummaries,
} from "./runs";
import { ensureStoreSchema, getStore } from "./store";

type Store = Awaited<ReturnType<typeof getStore>>;

export interface ApprovalListQuery {
  status?: ApprovalStatus;
  sort?: "due" | "created";
  cursor?: string | null;
  limit?: number;
}

export interface ApprovalListResult {
  approvals: ApprovalApiItem[];
  nextCursor: string | null;
}

export interface ApprovalDetail {
  run: RunDetail["run"];
  detail: RunDetail;
  approval: NonNullable<RunDetail["approval"]>;
  draft: ArtifactView | null;
  draftContent: string;
  draftUnavailable: boolean;
  expired: boolean;
  actionable: boolean;
}

export interface InboxData {
  paused: Awaited<ReturnType<typeof loadPausedRuns>>;
  failed: Array<{
    run: RunDetail["run"];
    costCny: number;
    artifactCount: number;
    reason: string;
  }>;
}

export const loadApprovalDetail = cache(async function loadApprovalDetail(
  requestId: string,
  store?: Store,
): Promise<ApprovalDetail | null> {
  await ensureStoreSchema();
  const client = store ?? (await getStore());

  // The approvals table points straight at the run; only fall back to the
  // legacy scan for requests created before the entity existed.
  const record = await client.approvals.get(requestId);
  if (record) {
    const detail = await loadRunDetail(record.runId, client);
    if (detail?.approval?.requestId === requestId) {
      return buildApprovalDetail(detail, client);
    }
  }

  const paused = await client.runs.list({ status: "paused", limit: 50 });
  const recent = await client.runs.listRecent(50);
  const seen = new Set<string>();
  const candidates = [...paused, ...recent].filter((run) => {
    if (seen.has(run.runId)) {
      return false;
    }
    seen.add(run.runId);
    return true;
  });

  for (const run of candidates) {
    const detail = await loadRunDetail(run.runId, client);
    if (!detail?.approval || detail.approval.requestId !== requestId) {
      continue;
    }
    return buildApprovalDetail(detail, client);
  }

  return null;
});

async function buildApprovalDetail(
  detail: RunDetail,
  client: Store,
): Promise<ApprovalDetail> {
  if (!detail.approval) {
    throw new Error("approval detail requires an approval view");
  }
  const draft =
    detail.artifacts.find(
      (view) => view.artifact.artifactId === detail.approval?.draftArtifactId,
    ) ?? null;
  const content = draft
    ? await loadArtifactContent(draft.artifact, client, 16_000)
    : { text: "", truncated: false, unavailable: false };
  const expired = Boolean(
    detail.approval.expiresAt &&
      new Date(detail.approval.expiresAt).getTime() < Date.now(),
  );

  return {
    run: detail.run,
    detail,
    approval: detail.approval,
    draft,
    draftContent: content.text,
    draftUnavailable: content.unavailable,
    expired,
    actionable: detail.run.status === "paused" && !expired,
  };
}

export async function findRunIdForRequest(
  requestId: string,
  store?: Store,
): Promise<string | null> {
  await ensureStoreSchema();
  const client = store ?? (await getStore());
  const record = await client.approvals.get(requestId);
  if (record) {
    return record.runId;
  }

  // Legacy requests materialize on the next autopilot tick or inbox read; keep
  // the artifact scan as a fallback for callers that arrive first.
  const { findApprovalRequest } = await import("@kit/manager");
  const paused = await client.runs.list({ status: "paused", limit: 50 });
  for (const run of paused) {
    const approval = await findApprovalRequest(client, run.runId);
    if (approval?.requestId === requestId) {
      return run.runId;
    }
  }
  return null;
}

let backfillPromise: Promise<void> | undefined;

/**
 * Materialize approval entities from paused runs, once per web process.
 * Existing installs keep their inbox across the upgrade without a manual step;
 * the autopilot tick runs the same idempotent backfill for CLI/worker setups.
 */
export async function ensureApprovalsBackfill(): Promise<void> {
  backfillPromise ??= (async () => {
    await ensureStoreSchema();
    const client = await getStore();
    const { backfillApprovals } = await import("@kit/manager");
    await backfillApprovals(client);
  })().catch((error) => {
    console.error(
      `[approvals] backfill failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  await backfillPromise;
}

/**
 * Inbox query backed by the approvals table (one indexed SELECT). The default
 * keeps the legacy contract: queued requests whose run is still paused.
 */
export async function loadPendingApprovals(
  store?: Store,
  query: ApprovalListQuery = {},
): Promise<ApprovalListResult> {
  await ensureStoreSchema();
  const client = store ?? (await getStore());
  const explicitStatus = query.status !== undefined;
  const page = await client.approvals.list({
    status: query.status ?? "queued",
    ...(explicitStatus ? {} : { runStatus: "paused" }),
    sort: query.sort ?? "due",
    cursor: query.cursor ?? null,
    limit: query.limit ?? 50,
  });

  const approvals = await Promise.all(
    page.items.map(async (item) => {
      const payload = await loadApprovalPayload(client, item.payloadRef);
      const entity: ApprovalEntityView = {
        approvalId: item.approvalId,
        runId: item.runId,
        workflowId: item.workflowId,
        stageId: item.stageId,
        stageName: item.stageName,
        kind: item.kind,
        status: item.status,
        slaDueAt: item.slaDueAt,
        expiresAt: item.expiresAt,
        version: item.version,
        runStatus: item.runStatus,
      };
      return toApiApprovalItem(entity, payload);
    }),
  );

  return { approvals, nextCursor: page.nextCursor };
}

async function loadApprovalPayload(
  client: Store,
  payloadRef: string | null,
): Promise<Record<string, unknown> | null> {
  if (!payloadRef) {
    return null;
  }
  try {
    const artifact = await client.artifactStore.findById(payloadRef);
    if (!artifact) {
      return null;
    }
    const content = await loadArtifactContent(artifact, client, 200_000);
    if (content.unavailable) {
      return null;
    }
    return JSON.parse(content.text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const loadInboxData = cache(async function loadInboxData(
  store?: Store,
): Promise<InboxData> {
  const client = store ?? (await getStore());
  const [paused, summaries] = await Promise.all([
    loadPausedRuns(client),
    loadRunSummaries(30, client),
  ]);

  const failedSummaries = summaries
    .filter((item) => item.run.status === "failed")
    .slice(0, 6);

  const failed = await Promise.all(
    failedSummaries.map(async (item) => {
      const detail = await loadRunDetail(item.run.runId, client);
      const stageError =
        detail?.stages.find((stage) => stage.error)?.error ?? "";
      return {
        run: item.run,
        costCny: item.costCny,
        artifactCount: item.artifactCount,
        reason: stageError || "run failed",
      };
    }),
  );

  return { paused, failed };
});
