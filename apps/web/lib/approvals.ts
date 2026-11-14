import { cache } from "react";
import type { ArtifactView, RunDetail } from "./runs";
import {
  loadArtifactContent,
  loadPausedRuns,
  loadRunDetail,
  loadRunSummaries,
} from "./runs";
import { getStore } from "./store";

type Store = Awaited<ReturnType<typeof getStore>>;

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
  const client = store ?? (await getStore());
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

  return null;
});

export async function findRunIdForRequest(
  requestId: string,
  store?: Store,
): Promise<string | null> {
  const client = store ?? (await getStore());
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

export async function loadPendingApprovals(store?: Store) {
  const client = store ?? (await getStore());
  const { findApprovalRequest } = await import("@kit/manager");
  const paused = await client.runs.list({ status: "paused", limit: 50 });
  return Promise.all(
    paused.map(async (run) => {
      const approval = await findApprovalRequest(client, run.runId);
      if (!approval) {
        return null;
      }
      return {
        runId: run.runId,
        workflowId: run.workflowId,
        requestId: approval.requestId,
        stageId: approval.stageId,
        stageName: approval.stageName,
        requestType: approval.requestType,
        riskClass: approval.riskClass,
        summary: approval.summary,
        options: approval.options,
        expiresAt: approval.expiresAt,
      };
    }),
  ).then((items) => items.filter((item) => item !== null));
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
