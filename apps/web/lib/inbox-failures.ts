import { cache } from "react";
import { loadRunDetail, loadRunSummaries } from "./runs";
import { ensureStoreSchema, getStore } from "./store";

type Store = Awaited<ReturnType<typeof getStore>>;

export interface InboxFailure {
  runId: string;
  workflowId: string;
  updatedAt: string;
  costCny: number;
  artifactCount: number;
  reason: string;
}

/**
 * Lightweight failure strip under the approval tower. Unlike the legacy inbox
 * loader it never scans paused runs, so it stays cheap on large queues.
 */
export const loadRecentFailures = cache(async function loadRecentFailures(
  store?: Store,
): Promise<InboxFailure[]> {
  if (!store) {
    await ensureStoreSchema();
  }
  const client = store ?? (await getStore());
  const summaries = await loadRunSummaries(30, client);
  const failed = summaries
    .filter((item) => item.run.status === "failed")
    .slice(0, 5);

  return Promise.all(
    failed.map(async (item) => {
      const detail = await loadRunDetail(item.run.runId, client);
      const stageError =
        detail?.stages.find((stage) => stage.error)?.error ?? "";
      return {
        runId: item.run.runId,
        workflowId: item.run.workflowId,
        updatedAt: item.run.updatedAt,
        costCny: item.costCny,
        artifactCount: item.artifactCount,
        reason: stageError || "run failed",
      };
    }),
  );
});
