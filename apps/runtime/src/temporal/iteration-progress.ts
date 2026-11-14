import type { TaskPlan } from "@kit/core";
import type { initStore } from "@kit/store";
import type { IterationInput } from "@kit/workflow";

type Store = Awaited<ReturnType<typeof initStore>>;

export interface RunPatch {
  status?: string;
  phase?: string;
  error?: string;
  planArtifactId?: string;
  reportArtifactId?: string;
  finishedAt?: string;
}

export interface TaskPatch {
  status?: string;
  phase?: string;
  attempt?: number;
  coder?: string;
  risk?: string;
  changedFiles?: string[];
  tokens?: number;
  coderSummary?: string;
  applyStatus?: string;
  commit?: string;
  error?: string;
  diffArtifactId?: string;
  transcriptArtifactId?: string;
  resultArtifactId?: string;
  verificationArtifactId?: string;
  applyArtifactId?: string;
  startedAt?: string;
  finishedAt?: string;
}

export async function startIteration(
  store: Store,
  input: IterationInput,
  plan: TaskPlan,
  planArtifactId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await store.sql`
    INSERT INTO iteration_runs (
      iteration_id, workflow_id, workspace_id, goal, acceptance, run_mode,
      apply_mode, status, phase, plan_artifact_id, started_at, updated_at
    ) VALUES (
      ${input.iterationId}, ${`iteration-${input.iterationId}`},
      ${input.workspaceId}, ${input.goal}, ${input.acceptance ?? null},
      ${input.runMode}, ${input.applyMode}, 'running', 'planned',
      ${planArtifactId}, ${now}, ${now}
    )
    ON CONFLICT (iteration_id) DO UPDATE SET
      goal = EXCLUDED.goal,
      acceptance = EXCLUDED.acceptance,
      run_mode = EXCLUDED.run_mode,
      apply_mode = EXCLUDED.apply_mode,
      status = 'running',
      phase = 'planned',
      plan_artifact_id = EXCLUDED.plan_artifact_id,
      error = NULL,
      started_at = EXCLUDED.started_at,
      updated_at = EXCLUDED.updated_at,
      finished_at = NULL
  `;
  await store.sql`
    DELETE FROM iteration_tasks WHERE iteration_id = ${input.iterationId}
  `;
  for (const task of plan.tasks) {
    await store.sql`
      INSERT INTO iteration_tasks (
        iteration_id, task_id, domain, goal, acceptance, status, phase,
        started_at, updated_at
      ) VALUES (
        ${input.iterationId}, ${task.id}, ${task.domain}, ${task.goal},
        ${task.acceptance}, 'pending', 'planned', ${now}, ${now}
      )
      ON CONFLICT (iteration_id, task_id) DO NOTHING
    `;
  }
}

export async function updateRun(
  store: Store,
  iterationId: string,
  patch: RunPatch,
): Promise<void> {
  const now = new Date().toISOString();
  await store.sql`
    UPDATE iteration_runs SET
      status = COALESCE(${patch.status ?? null}, status),
      phase = COALESCE(${patch.phase ?? null}, phase),
      error = COALESCE(${patch.error ?? null}, error),
      plan_artifact_id = COALESCE(${patch.planArtifactId ?? null}, plan_artifact_id),
      report_artifact_id = COALESCE(${patch.reportArtifactId ?? null}, report_artifact_id),
      finished_at = COALESCE(${patch.finishedAt ?? null}, finished_at),
      updated_at = ${now}
    WHERE iteration_id = ${iterationId}
  `;
}

export async function updateTask(
  store: Store,
  iterationId: string,
  taskId: string,
  patch: TaskPatch,
): Promise<void> {
  const now = new Date().toISOString();
  const changedFiles = patch.changedFiles
    ? JSON.stringify(patch.changedFiles)
    : null;
  await store.sql`
    UPDATE iteration_tasks SET
      status = COALESCE(${patch.status ?? null}, status),
      phase = COALESCE(${patch.phase ?? null}, phase),
      attempt = COALESCE(${patch.attempt ?? null}, attempt),
      coder = COALESCE(${patch.coder ?? null}, coder),
      risk = COALESCE(${patch.risk ?? null}, risk),
      changed_files = COALESCE(${changedFiles}::jsonb, changed_files),
      tokens = COALESCE(${patch.tokens ?? null}, tokens),
      coder_summary = COALESCE(${patch.coderSummary ?? null}, coder_summary),
      apply_status = COALESCE(${patch.applyStatus ?? null}, apply_status),
      commit_sha = COALESCE(${patch.commit ?? null}, commit_sha),
      error = COALESCE(${patch.error ?? null}, error),
      diff_artifact_id = COALESCE(${patch.diffArtifactId ?? null}, diff_artifact_id),
      transcript_artifact_id = COALESCE(${patch.transcriptArtifactId ?? null}, transcript_artifact_id),
      result_artifact_id = COALESCE(${patch.resultArtifactId ?? null}, result_artifact_id),
      verification_artifact_id = COALESCE(${patch.verificationArtifactId ?? null}, verification_artifact_id),
      apply_artifact_id = COALESCE(${patch.applyArtifactId ?? null}, apply_artifact_id),
      started_at = COALESCE(${patch.startedAt ?? null}, started_at),
      finished_at = COALESCE(${patch.finishedAt ?? null}, finished_at),
      updated_at = ${now}
    WHERE iteration_id = ${iterationId} AND task_id = ${taskId}
  `;
}

export async function failIteration(
  store: Store,
  iterationId: string,
  error: string,
): Promise<void> {
  await updateRun(store, iterationId, {
    status: "failed",
    phase: "failed",
    error,
    finishedAt: new Date().toISOString(),
  });
}
