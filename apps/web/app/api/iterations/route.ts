import type {
  IterationData,
  IterationRunView,
  IterationTaskView,
} from "@/lib/iteration-types";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureStoreSchema();
  const store = getStore();

  const runs = await store.sql<
    Array<{
      iteration_id: string;
      workflow_id: string | null;
      goal: string;
      acceptance: string | null;
      run_mode: string;
      apply_mode: string;
      status: string;
      phase: string;
      plan_artifact_id: string | null;
      report_artifact_id: string | null;
      error: string | null;
      started_at: Date | string;
      updated_at: Date | string;
      finished_at: Date | string | null;
    }>
  >`
    SELECT * FROM iteration_runs
    ORDER BY updated_at DESC
    LIMIT 20
  `;

  const tasks = await store.sql<
    Array<{
      iteration_id: string;
      task_id: string;
      domain: string;
      goal: string;
      acceptance: string;
      status: string;
      phase: string;
      attempt: number;
      coder: string | null;
      risk: string | null;
      changed_files: string[] | string;
      tokens: number;
      coder_summary: string | null;
      apply_status: string | null;
      commit_sha: string | null;
      error: string | null;
      diff_artifact_id: string | null;
      transcript_artifact_id: string | null;
      verification_artifact_id: string | null;
      apply_artifact_id: string | null;
      started_at: Date | string;
      updated_at: Date | string;
      finished_at: Date | string | null;
    }>
  >`
    SELECT * FROM iteration_tasks
    WHERE iteration_id IN (
      SELECT iteration_id FROM iteration_runs
      ORDER BY updated_at DESC LIMIT 20
    )
    ORDER BY started_at ASC
  `;

  const byRun = new Map<string, IterationTaskView[]>();
  for (const row of tasks) {
    const list = byRun.get(row.iteration_id) ?? [];
    list.push({
      taskId: row.task_id,
      domain: row.domain,
      goal: row.goal,
      acceptance: row.acceptance,
      status: row.status,
      phase: row.phase,
      attempt: row.attempt,
      coder: row.coder,
      risk: row.risk,
      changedFiles: Array.isArray(row.changed_files)
        ? row.changed_files
        : (JSON.parse(row.changed_files) as string[]),
      tokens: row.tokens,
      coderSummary: row.coder_summary,
      applyStatus: row.apply_status,
      commit: row.commit_sha,
      error: row.error,
      diffArtifactId: row.diff_artifact_id,
      transcriptArtifactId: row.transcript_artifact_id,
      verificationArtifactId: row.verification_artifact_id,
      applyArtifactId: row.apply_artifact_id,
      startedAt: toIso(row.started_at) ?? "",
      updatedAt: toIso(row.updated_at) ?? "",
      finishedAt: toIso(row.finished_at),
    });
    byRun.set(row.iteration_id, list);
  }

  const data: IterationData = {
    runs: runs.map((row) => {
      const runTasks = byRun.get(row.iteration_id) ?? [];
      const run: IterationRunView = {
        iterationId: row.iteration_id,
        workflowId: row.workflow_id,
        goal: row.goal,
        acceptance: row.acceptance,
        runMode: row.run_mode,
        applyMode: row.apply_mode,
        status: row.status,
        phase: row.phase,
        tokens: runTasks.reduce((sum, task) => sum + task.tokens, 0),
        planArtifactId: row.plan_artifact_id,
        reportArtifactId: row.report_artifact_id,
        error: row.error,
        startedAt: toIso(row.started_at) ?? "",
        updatedAt: toIso(row.updated_at) ?? "",
        finishedAt: toIso(row.finished_at),
      };
      return { run, tasks: runTasks };
    }),
    generatedAt: new Date().toISOString(),
  };

  return NextResponse.json(data);
}

function toIso(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}
