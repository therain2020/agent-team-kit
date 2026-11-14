import type { CoderStreamEvent } from "@kit/coder";
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
  await appendEvent(store, {
    iterationId: input.iterationId,
    kind: "run.started",
    status: "running",
    summary: input.goal,
    payload: { runMode: input.runMode, applyMode: input.applyMode },
  });
  for (const task of plan.tasks) {
    await appendEvent(store, {
      iterationId: input.iterationId,
      taskId: task.id,
      kind: "task.planned",
      status: "pending",
      summary: task.goal,
      payload: { domain: task.domain, risk: task.risk },
    });
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
    ? store.sql.json(patch.changedFiles)
    : null;
  await store.sql`
    UPDATE iteration_tasks SET
      status = COALESCE(${patch.status ?? null}, status),
      phase = COALESCE(${patch.phase ?? null}, phase),
      attempt = COALESCE(${patch.attempt ?? null}, attempt),
      coder = COALESCE(${patch.coder ?? null}, coder),
      risk = COALESCE(${patch.risk ?? null}, risk),
      changed_files = COALESCE(${changedFiles}, changed_files),
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

export interface IterationEventInput {
  iterationId: string;
  taskId?: string;
  turn?: number;
  step?: number;
  kind: string;
  status?: string;
  tool?: string;
  summary?: string;
  tokens?: number;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export async function appendEvent(
  store: Store,
  input: IterationEventInput,
): Promise<number> {
  const at = input.createdAt ?? new Date().toISOString();
  return await store.sql.begin(async (tx) => {
    const rows = await tx<Array<{ event_id: number }>>`
      INSERT INTO iteration_events (
        iteration_id, task_id, turn, step, kind, status, tool, summary,
        payload, created_at
      ) VALUES (
        ${input.iterationId}, ${input.taskId ?? null}, ${input.turn ?? null},
        ${input.step ?? null}, ${input.kind}, ${input.status ?? null},
        ${input.tool ?? null}, ${input.summary ?? null},
        ${store.sql.json(input.payload ?? {})}, ${at}
      )
      RETURNING event_id
    `;
    const eventId = Number(rows[0]?.event_id ?? 0);
    if (!eventId) {
      throw new Error("failed to append iteration event");
    }

    const turn = input.turn;
    const hasTurn = Boolean(input.taskId) && typeof turn === "number";
    if (hasTurn && input.taskId && typeof turn === "number") {
      const isTurnStart = input.kind === "coder.turn_start";
      const isTurnEnd =
        input.kind === "coder.turn_end" ||
        input.kind === "coder.final" ||
        input.kind === "coder.error";
      const turnStatus = isTurnStart
        ? "running"
        : isTurnEnd
          ? (input.status ?? "completed")
          : "running";
      const finishedAt = isTurnEnd ? at : null;
      const steps = input.kind === "coder.step_start" ? (input.step ?? 1) : 0;
      const toolDelta = input.kind === "coder.tool_call" ? 1 : 0;
      const summary =
        input.kind === "coder.thinking" ||
        input.kind === "coder.tool_call" ||
        input.kind === "coder.tool_result" ||
        input.kind === "coder.step_start" ||
        input.kind === "coder.step_end"
          ? null
          : (input.summary ?? null);
      const error =
        input.kind === "coder.error" ? (input.summary ?? null) : null;
      await tx`
        INSERT INTO iteration_turns (
          iteration_id, task_id, turn, status, started_at, finished_at,
          steps, tool_calls, tokens, summary, error, last_event_id
        ) VALUES (
          ${input.iterationId}, ${input.taskId}, ${turn}, ${turnStatus},
          ${at}, ${finishedAt}, ${steps}, ${toolDelta}, ${input.tokens ?? 0},
          ${summary}, ${error}, ${eventId}
        )
        ON CONFLICT (iteration_id, task_id, turn) DO UPDATE SET
          status = CASE
            WHEN ${isTurnStart} THEN 'running'
            WHEN ${isTurnEnd} THEN ${turnStatus}
            ELSE iteration_turns.status
          END,
          finished_at = COALESCE(${finishedAt}, iteration_turns.finished_at),
          steps = GREATEST(iteration_turns.steps, ${steps}),
          tool_calls = iteration_turns.tool_calls + ${toolDelta},
          tokens = GREATEST(iteration_turns.tokens, ${input.tokens ?? 0}),
          summary = COALESCE(${summary}, iteration_turns.summary),
          error = COALESCE(${error}, iteration_turns.error),
          last_event_id = ${eventId}
      `;
    }

    await tx`
      UPDATE iteration_runs SET
        last_heartbeat_at = ${at},
        last_event_id = ${eventId},
        turn_count = GREATEST(turn_count, ${input.turn ?? 0}),
        tool_calls = tool_calls + ${input.kind === "coder.tool_call" ? 1 : 0},
        updated_at = ${at}
      WHERE iteration_id = ${input.iterationId}
    `;
    if (input.taskId) {
      await tx`
        UPDATE iteration_tasks SET
          last_heartbeat_at = ${at},
          turn_count = GREATEST(turn_count, ${input.turn ?? 0}),
          tool_calls = tool_calls + ${input.kind === "coder.tool_call" ? 1 : 0},
          tokens = GREATEST(tokens, ${input.tokens ?? 0}),
          updated_at = ${at}
        WHERE iteration_id = ${input.iterationId} AND task_id = ${input.taskId}
      `;
    }

    await tx.notify(
      "kit_iteration_events",
      JSON.stringify({
        iterationId: input.iterationId,
        eventId,
        taskId: input.taskId ?? null,
        kind: input.kind,
      }),
    );
    return eventId;
  });
}

export async function appendCoderEvent(
  store: Store,
  iterationId: string,
  taskId: string,
  event: CoderStreamEvent,
): Promise<number> {
  return await appendEvent(store, {
    iterationId,
    taskId,
    turn: event.turn,
    step: event.step,
    kind: `coder.${event.kind}`,
    status: event.status,
    tool: event.tool,
    summary: event.summary,
    tokens: event.tokens,
    payload: {
      ...(event.payload ?? {}),
      ...(event.callId ? { callId: event.callId } : {}),
      ...(typeof event.tokens === "number" ? { tokens: event.tokens } : {}),
    },
    createdAt: event.at,
  });
}

export async function touchHeartbeat(
  store: Store,
  iterationId: string,
  taskId?: string,
): Promise<void> {
  const now = new Date().toISOString();
  await store.sql`
    UPDATE iteration_runs
    SET last_heartbeat_at = ${now}, updated_at = ${now}
    WHERE iteration_id = ${iterationId}
  `;
  if (taskId) {
    await store.sql`
      UPDATE iteration_tasks
      SET last_heartbeat_at = ${now}
      WHERE iteration_id = ${iterationId} AND task_id = ${taskId}
    `;
  }
}

export async function failIteration(
  store: Store,
  iterationId: string,
  error: string,
): Promise<void> {
  await appendEvent(store, {
    iterationId,
    kind: "run.failed",
    status: "failed",
    summary: error,
    payload: { error },
  });
  await updateRun(store, iterationId, {
    status: "failed",
    phase: "failed",
    error,
    finishedAt: new Date().toISOString(),
  });
}
