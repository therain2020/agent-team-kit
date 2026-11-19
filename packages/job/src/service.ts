import { createHash } from "node:crypto";
import path from "node:path";
import {
  type CoderId,
  type RunBudgetSpec,
  type RunOrigin,
  type RunOriginKind,
  cnyToMicro,
  eventEnvelopeSchema,
  missionAssignmentSchema,
  newId,
} from "@kit/core";
import {
  assertKillSwitchClear,
  enqueueLocalIteration,
  enqueueLocalRun,
} from "@kit/engine";
import {
  buildPackRun,
  loadPack,
  planAgents,
  rolePlanForAgents,
  simulatePack,
  validateRolePlan,
} from "@kit/pack";
import type { AdmitRunInput, initStore } from "@kit/store";
import {
  type IterationInput,
  createTemporalClient,
  taskQueue,
} from "@kit/workflow";
import { type ProjectTarget, resolveProjectTarget } from "./projects";
import {
  type JobApplyMode,
  JobError,
  type JobKind,
  type JobOriginRecord,
  type JobRunMode,
  type JobSummary,
  type StartJobInput,
  type StartJobResult,
  normalizeJobOrigin,
} from "./types";

type Store = Awaited<ReturnType<typeof initStore>>;

export interface JobServiceOptions {
  repoRoot: string;
  /**
   * Trusted internal triggers (event router canary variants live outside
   * `packs/`) may point at a pack dir outside the packs root.
   */
  allowPackOutsideRoot?: boolean;
}

export async function startJob(
  store: Store,
  input: StartJobInput,
  options: JobServiceOptions,
): Promise<StartJobResult> {
  const workspaceId = input.workspaceId ?? "default";
  await assertKillSwitchClear(store, { workspaceId }, "run");
  const runMode: JobRunMode = input.runMode ?? "DRY_RUN";
  const origin = normalizeJobOrigin(input.origin);
  const packDir = resolvePackDir(
    options.repoRoot,
    input.packDir,
    origin.kind === "cli" || options.allowPackOutsideRoot === true,
  );
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new JobError(
      "invalid_pack",
      `invalid pack: ${loaded.errors.join("; ")}`,
    );
  }
  if (input.kind === "iteration") {
    const project = await resolveProjectTarget(options.repoRoot, {
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.projectPath ? { projectPath: input.projectPath } : {}),
    });
    return await startIterationJob(
      store,
      input,
      origin,
      runMode,
      packDir,
      loaded,
      project,
      workspaceId,
    );
  }
  return await startPackRunJob(
    store,
    input,
    origin,
    runMode,
    packDir,
    loaded,
    workspaceId,
  );
}

/**
 * Triggers that need a run id before starting (canary bucketing, event
 * dedupe) derive it from the same helper so pack runs and retries agree.
 */
export function dedupeRunId(dedupeKey: string): string {
  return `run_${hash(dedupeKey)}`;
}

export async function listJobs(
  store: Store,
  filter: { kind?: JobKind; status?: string; limit?: number } = {},
): Promise<JobSummary[]> {
  const limit = clampInt(filter.limit, 1, 100, 20);
  const jobs: JobSummary[] = [];

  if (!filter.kind || filter.kind === "iteration") {
    const rows = filter.status
      ? await store.sql<IterationJobRow[]>`
          SELECT iteration_id, goal, status, phase, run_mode, workflow_id,
                 origin_kind, trigger_id, trigger_run_id,
                 started_at, updated_at, finished_at
          FROM iteration_runs
          WHERE status = ${filter.status}
          ORDER BY updated_at DESC
          LIMIT ${limit}
        `
      : await store.sql<IterationJobRow[]>`
          SELECT iteration_id, goal, status, phase, run_mode, workflow_id,
                 origin_kind, trigger_id, trigger_run_id,
                 started_at, updated_at, finished_at
          FROM iteration_runs
          ORDER BY updated_at DESC
          LIMIT ${limit}
        `;
    for (const row of rows) {
      jobs.push({
        jobId: row.iteration_id,
        kind: "iteration",
        goal: row.goal,
        status: row.status,
        phase: row.phase,
        runMode: row.run_mode,
        workflowId: row.workflow_id,
        ...originSummary(row),
        createdAt: iso(row.started_at),
        updatedAt: iso(row.updated_at),
        finishedAt: row.finished_at ? iso(row.finished_at) : null,
      });
    }
  }

  if (!filter.kind || filter.kind === "packRun") {
    const rows = filter.status
      ? await store.sql<RunJobRow[]>`
          SELECT run_id, workflow_id, run_mode, status, origin_kind, trigger_id,
                 trigger_run_id, created_at, updated_at
          FROM runs
          WHERE status = ${filter.status}
          ORDER BY updated_at DESC
          LIMIT ${limit}
        `
      : await store.sql<RunJobRow[]>`
          SELECT run_id, workflow_id, run_mode, status, origin_kind, trigger_id,
                 trigger_run_id, created_at, updated_at
          FROM runs
          ORDER BY updated_at DESC
          LIMIT ${limit}
        `;
    for (const row of rows) {
      jobs.push({
        jobId: row.run_id,
        kind: "packRun",
        goal: null,
        status: row.status,
        phase: null,
        runMode: row.run_mode,
        workflowId: row.workflow_id,
        ...originSummary(row),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        finishedAt: null,
      });
    }
  }

  return jobs
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

export async function getJob(
  store: Store,
  kind: JobKind,
  jobId: string,
): Promise<JobSummary | null> {
  if (kind === "iteration") {
    const rows = await store.sql<IterationJobRow[]>`
      SELECT iteration_id, goal, status, phase, run_mode, workflow_id,
             origin_kind, trigger_id, trigger_run_id,
             started_at, updated_at, finished_at
      FROM iteration_runs WHERE iteration_id = ${jobId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      jobId: row.iteration_id,
      kind: "iteration",
      goal: row.goal,
      status: row.status,
      phase: row.phase,
      runMode: row.run_mode,
      workflowId: row.workflow_id,
      ...originSummary(row),
      createdAt: iso(row.started_at),
      updatedAt: iso(row.updated_at),
      finishedAt: row.finished_at ? iso(row.finished_at) : null,
    };
  }

  const rows = await store.sql<RunJobRow[]>`
    SELECT run_id, workflow_id, run_mode, status, origin_kind, trigger_id,
           trigger_run_id, created_at, updated_at
    FROM runs WHERE run_id = ${jobId} LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    jobId: row.run_id,
    kind: "packRun",
    goal: null,
    status: row.status,
    phase: null,
    runMode: row.run_mode,
    workflowId: row.workflow_id,
    ...originSummary(row),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    finishedAt: null,
  };
}

export async function abortJob(
  store: Store,
  kind: JobKind,
  jobId: string,
  options: JobServiceOptions,
): Promise<{ jobId: string; kind: JobKind; cancelled: boolean }> {
  const job = await getJob(store, kind, jobId);
  if (job && isTerminal(job.status)) {
    throw new JobError(
      "already_finished",
      `${jobId} is already ${job.status}`,
      409,
    );
  }

  if (store.driver === "sqlite") {
    if (kind === "iteration") {
      return await abortLocalIteration(store, jobId);
    }
    // A queued local run has no runs row yet; the request is the source of truth.
    const request = await store.runRequests.find(jobId);
    if (!request) {
      throw new JobError("not_found", `${kind} ${jobId} not found`, 404);
    }
    if (request.status === "claimed") {
      throw new JobError(
        "already_running",
        "local run is already claimed and cannot be aborted",
        409,
      );
    }
    await store.sql`
      UPDATE run_requests SET status = 'cancelled', error = 'aborted by operator',
        updated_at = ${new Date().toISOString()}
      WHERE run_id = ${jobId} AND status = 'queued'
    `;
    return { jobId, kind, cancelled: true };
  }

  if (!job && kind === "iteration") {
    throw new JobError("not_found", `${kind} ${jobId} not found`, 404);
  }

  const workflowId =
    job?.workflowId ??
    (kind === "iteration" ? `iteration-${jobId}` : `pack-${jobId}`);
  const { client, connection } = await createTemporalClient();
  try {
    const handle = client.workflow.getHandle(workflowId);
    await handle.cancel();
  } catch (error) {
    throw new JobError(
      "cancel_failed",
      error instanceof Error ? error.message : String(error),
      502,
    );
  } finally {
    await connection.close();
  }
  if (kind === "iteration") {
    const now = new Date().toISOString();
    await store.sql`
      UPDATE iteration_runs SET status = 'cancelled', phase = 'cancelled',
        error = COALESCE(error, 'aborted by operator'),
        finished_at = ${now}, updated_at = ${now}
      WHERE iteration_id = ${jobId}
    `;
  }
  return { jobId, kind, cancelled: true };
}

async function startPackRunJob(
  store: Store,
  input: StartJobInput,
  origin: JobOriginRecord,
  runMode: JobRunMode,
  packDir: string,
  loaded: Awaited<ReturnType<typeof loadPack>>,
  workspaceId: string,
): Promise<StartJobResult> {
  if (!loaded.ok) {
    throw new JobError("invalid_pack", "invalid pack");
  }
  const workflowId =
    input.workflow ??
    (loaded.workflows.length > 0 ? loaded.workflows[0]?.id : undefined);
  if (!workflowId) {
    throw new JobError("workflow_required", "workflow is required");
  }
  if (!loaded.workflows.some((workflow) => workflow.id === workflowId)) {
    throw new JobError("unknown_workflow", `unknown workflow: ${workflowId}`);
  }

  const dedupeKey = input.dedupeKey?.trim();
  const runId = input.runId ?? (dedupeKey ? dedupeRunId(dedupeKey) : undefined);
  if (dedupeKey && runId) {
    const existing = await findExistingPackRun(store, runId);
    if (existing) {
      return {
        jobId: runId,
        kind: "packRun",
        workflowId: `pack-${runId}`,
        engine: store.driver === "sqlite" ? "local" : "temporal",
        runMode,
        pack: loaded.pack.metadata.name,
        workflow: workflowId,
        ...(existing.requestId ? { requestId: existing.requestId } : {}),
        deduped: true,
      };
    }
  }

  const mission = await resolveMission(
    store,
    loaded,
    input,
    workflowId,
    origin,
  );
  const evidenceText = await resolveEvidence(store, input);
  const missionGoal =
    mission && typeof mission.goal === "string" ? mission.goal : undefined;
  const goal = input.goal?.trim() ?? missionGoal;

  const budget = resolveBudgetSpec(input);
  let built: Awaited<ReturnType<typeof buildPackRun>>;
  try {
    built = await buildPackRun(loaded, {
      workflow: workflowId,
      ...(input.inputFile
        ? { inputFile: input.inputFile }
        : { input: evidenceText ?? goal }),
      stub: input.stub === true,
      runMode,
      workspaceId,
      ...(runId ? { runId } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
      ...(budget ? { budget } : {}),
      origin: toRunOrigin(origin),
    });
    if (input.eventId) {
      built.input.eventId = input.eventId;
    }
    if (input.priority) {
      built.input.priority = input.priority;
    }
  } catch (error) {
    throw new JobError(
      "build_failed",
      error instanceof Error ? error.message : "failed to build run",
    );
  }

  await admitRunOrThrow(store, {
    workspaceId: built.input.workspaceId,
    runId: built.input.runId,
    ...(budget ? { spec: budget } : {}),
    stages: built.input.stages.map((stage) => ({
      stageId: stage.stageId,
      stageName: stage.stageName,
      ...(stage.agentId ? { agentId: stage.agentId } : {}),
    })),
    ...estimateWorkflowBudget(loaded, workflowId),
  });

  const now = new Date().toISOString();
  const event = eventEnvelopeSchema.parse({
    eventId: built.input.eventId,
    type: built.eventType,
    schemaVersion: "1.0",
    occurredAt: now,
    receivedAt: now,
    workspaceId: built.input.workspaceId,
    idempotencyKey: `${origin.kind}:${built.input.runId}`,
    traceId: newId("trc"),
    payloadRef: "memory://job",
  });
  await store.events.insert(event);

  if (mission) {
    await store.artifactService.publish({
      workspaceId: built.input.workspaceId,
      content: new TextEncoder().encode(JSON.stringify(mission, null, 2)),
      producer: {
        agentId: "manager",
        agentVersion: "1.0.0",
        promptHash: "sha256:mission-assignment",
        modelId: "none",
      },
      inputs: [],
      runId: built.input.runId,
      stageId: `${built.input.runId}:mission-assignment`,
      runMode,
      cost: { currency: "CNY", amount: 0, tokens: 0 },
      sensitivity: "internal",
      retentionClass: "artifact_365d",
    });
  }

  if (store.driver === "sqlite") {
    const queued = await enqueueLocalRun(built.input, store);
    return {
      jobId: built.input.runId,
      kind: "packRun",
      workflowId: `pack-${built.input.runId}`,
      engine: "local",
      runMode,
      pack: loaded.pack.metadata.name,
      workflow: workflowId,
      requestId: queued.requestId,
      ...(mission ? { mission } : {}),
    };
  }

  const { client, connection } = await createTemporalClient();
  try {
    const handle = await client.workflow.start("packWorkflow", {
      taskQueue,
      workflowId: `pack-${built.input.runId}`,
      args: [built.input],
    });
    return {
      jobId: built.input.runId,
      kind: "packRun",
      workflowId: handle.workflowId,
      engine: "temporal",
      runMode,
      pack: loaded.pack.metadata.name,
      workflow: workflowId,
      ...(mission ? { mission } : {}),
    };
  } catch (error) {
    throw new JobError(
      "start_failed",
      error instanceof Error ? error.message : "failed to start workflow",
      502,
    );
  } finally {
    await connection.close();
  }
}

async function startIterationJob(
  store: Store,
  input: StartJobInput,
  origin: JobOriginRecord,
  runMode: JobRunMode,
  packDir: string,
  loaded: Awaited<ReturnType<typeof loadPack>>,
  project: ProjectTarget,
  workspaceId: string,
): Promise<StartJobResult> {
  if (!loaded.ok) {
    throw new JobError("invalid_pack", "invalid pack");
  }
  if (!loaded.iteration) {
    throw new JobError(
      "iteration_pack_required",
      `pack has no iteration.yaml: ${packDir}`,
      404,
    );
  }
  if (!input.goal?.trim()) {
    throw new JobError("goal_required", "goal is required for an iteration");
  }
  const coder = parseCoder(input.coder);
  const applyMode: JobApplyMode =
    runMode === "LIVE" ? (input.applyMode ?? "low") : "none";
  if (runMode === "LIVE" && applyMode !== "none" && !project.onDefaultBranch) {
    const current = project.branch ?? "detached HEAD";
    const expected = project.defaultBranch ?? "the default branch";
    throw new JobError(
      "not_default_branch",
      `目标仓库当前在 ${current}，不是默认分支 ${expected}；请先切换到 ${expected} 再启动。`,
      409,
    );
  }
  const dedupeKey = input.dedupeKey?.trim();
  const iterationId = newId("it");
  const workflowId = dedupeKey
    ? `iteration-${workspaceId}-${hash(dedupeKey)}`
    : `iteration-${iterationId}`;

  if (dedupeKey) {
    const existing = await store.sql<Array<{ iteration_id: string }>>`
      SELECT iteration_id FROM iteration_runs
      WHERE workflow_id = ${workflowId} LIMIT 1
    `;
    const found = existing[0]?.iteration_id;
    if (found) {
      return {
        jobId: found,
        kind: "iteration",
        workflowId,
        engine: store.driver === "sqlite" ? "local" : "temporal",
        runMode,
        applyMode,
        pack: loaded.pack.metadata.name,
        project: projectRef(project),
        deduped: true,
      };
    }
  }

  const budget = resolveBudgetSpec(input);
  await admitRunOrThrow(store, {
    workspaceId,
    runId: iterationId,
    ...(budget ? { spec: budget } : {}),
    estimateCnyMicro: 0,
    estimateTokens: 0,
  });

  const iterationInput: IterationInput = {
    iterationId,
    workflowId,
    workspaceId,
    repoRoot: project.path,
    packDir,
    goal: input.goal.trim(),
    ...(input.acceptance ? { acceptance: input.acceptance } : {}),
    ...(input.domain ? { domain: input.domain } : {}),
    maxTasks: clampInt(input.maxTasks, 1, 20, 4),
    maxRepair: resolveRepairRounds(input.maxRepair),
    runMode,
    applyMode,
    ...(coder ? { coder } : {}),
    stub: input.stub === true,
    ...(input.budgetCny !== undefined ? { budgetCny: input.budgetCny } : {}),
    ...(budget ? { budget } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    origin: toRunOrigin(origin),
  };

  const now = new Date().toISOString();
  await store.sql`
    INSERT INTO iteration_runs (
      iteration_id, workflow_id, workspace_id, repo_root, origin_kind,
      trigger_id, trigger_run_id, goal, acceptance,
      run_mode, apply_mode, status, phase, started_at, updated_at
    ) VALUES (
      ${iterationId}, ${workflowId}, ${workspaceId}, ${project.path},
      ${origin.kind}, ${origin.triggerId ?? null}, ${origin.triggerRunId ?? null},
      ${iterationInput.goal}, ${iterationInput.acceptance ?? null},
      ${runMode}, ${applyMode}, 'running', 'queued', ${now}, ${now}
    )
    ON CONFLICT (iteration_id) DO NOTHING
  `;

  if (store.driver === "sqlite") {
    try {
      const queued = await enqueueLocalIteration(iterationInput, store);
      return {
        jobId: iterationId,
        kind: "iteration",
        workflowId,
        engine: "local",
        runMode,
        applyMode,
        pack: loaded.pack.metadata.name,
        project: projectRef(project),
        requestId: queued.requestId,
      };
    } catch (error) {
      await markIterationStartFailed(store, iterationId, error);
      throw new JobError(
        "start_failed",
        error instanceof Error ? error.message : "failed to enqueue job",
        502,
      );
    }
  }

  const { client, connection } = await createTemporalClient();
  try {
    const handle = await client.workflow.start("iterationWorkflow", {
      taskQueue,
      workflowId,
      args: [iterationInput],
      ...(dedupeKey
        ? { workflowIdConflictPolicy: "USE_EXISTING" as const }
        : {}),
    });
    return {
      jobId: iterationId,
      kind: "iteration",
      workflowId: handle.workflowId,
      engine: "temporal",
      runMode,
      applyMode,
      pack: loaded.pack.metadata.name,
      project: projectRef(project),
    };
  } catch (error) {
    await markIterationStartFailed(store, iterationId, error);
    throw new JobError(
      "start_failed",
      error instanceof Error ? error.message : "failed to start workflow",
      502,
    );
  } finally {
    await connection.close();
  }
}

/**
 * A dedupe key is honoured across engines: local runs are queued in
 * `run_requests`, while Temporal runs surface as a `runs` row once the
 * workflow starts. Either row means the trigger already fired.
 */
async function findExistingPackRun(
  store: Store,
  runId: string,
): Promise<{ requestId?: string } | null> {
  const request = await store.runRequests.find(runId);
  if (request) {
    return { requestId: request.requestId };
  }
  const run = await store.runs.get(runId);
  return run ? {} : null;
}

async function markIterationStartFailed(
  store: Store,
  iterationId: string,
  error: unknown,
): Promise<void> {
  const now = new Date().toISOString();
  await store.sql`
    UPDATE iteration_runs SET status = 'failed', phase = 'failed',
      error = ${error instanceof Error ? error.message : String(error)},
      finished_at = ${now}, updated_at = ${now}
    WHERE iteration_id = ${iterationId}
  `;
}

/**
 * Local abort is cooperative: a queued request is cancelled outright, while a
 * claimed run is marked `cancelling` so the runner stops at its next checkpoint.
 */
async function abortLocalIteration(
  store: Store,
  jobId: string,
): Promise<{ jobId: string; kind: JobKind; cancelled: boolean }> {
  const request = await store.runRequests.find(jobId);
  if (!request) {
    throw new JobError("not_found", `iteration ${jobId} not found`, 404);
  }
  const now = new Date().toISOString();

  if (request.status === "queued") {
    await store.sql`
      UPDATE run_requests SET status = 'cancelled', error = 'aborted by operator',
        updated_at = ${now}
      WHERE run_id = ${jobId} AND status = 'queued'
    `;
    await store.sql`
      UPDATE iteration_runs SET status = 'cancelled', phase = 'cancelled',
        error = COALESCE(error, 'aborted by operator'),
        finished_at = ${now}, updated_at = ${now}
      WHERE iteration_id = ${jobId}
    `;
    return { jobId, kind: "iteration", cancelled: true };
  }

  if (request.status === "claimed") {
    await store.sql`
      UPDATE iteration_runs SET status = 'cancelling', phase = 'cancelling',
        error = COALESCE(error, 'aborted by operator'), updated_at = ${now}
      WHERE iteration_id = ${jobId}
        AND status NOT IN ('succeeded', 'partial', 'failed', 'cancelled')
    `;
    return { jobId, kind: "iteration", cancelled: true };
  }

  throw new JobError(
    "already_finished",
    `${jobId} is already ${request.status}`,
    409,
  );
}

async function resolveMission(
  store: Store,
  loaded: Extract<Awaited<ReturnType<typeof loadPack>>, { ok: true }>,
  input: StartJobInput,
  workflowId: string,
  origin: JobOriginRecord,
): Promise<Record<string, unknown> | null> {
  if (!input.mission) {
    return null;
  }
  const manager =
    input.mission.manager?.trim() ||
    (loaded.pack.manager?.agent ? "manager" : "manager");
  const managerValid =
    manager === "manager" ||
    loaded.agents.has(manager) ||
    Boolean(loaded.pack.manager?.agent);
  if (!managerValid) {
    throw new JobError("invalid_manager", "invalid manager");
  }
  const requestedSellers = stringList(input.mission.sellers);
  const requestedBuilders = stringList(input.mission.builders);
  const requestedSpecialists = stringList(input.mission.specialists);
  const allowCombined = loaded.roleRules.allowCombined;
  let rolePlan =
    requestedSellers.length + requestedBuilders.length > 0
      ? {
          sellers: requestedSellers,
          builders: requestedBuilders,
          specialists: requestedSpecialists,
          allowCombined,
        }
      : rolePlanForAgents(loaded.agents, allowCombined);
  const selected = new Set(stringList(input.mission.agents));
  if (selected.size > 0) {
    rolePlan = {
      sellers: rolePlan.sellers.filter((id) => selected.has(id)),
      builders: rolePlan.builders.filter((id) => selected.has(id)),
      specialists: rolePlan.specialists.filter((id) => selected.has(id)),
      allowCombined,
    };
  }
  if (
    rolePlan.sellers.length === 0 &&
    rolePlan.builders.length === 0 &&
    rolePlan.specialists.length === 0
  ) {
    rolePlan = rolePlanForAgents(loaded.agents, allowCombined);
  }
  const roleErrors = validateRolePlan({
    agents: loaded.agents,
    rules: loaded.roleRules,
    sellers: rolePlan.sellers,
    builders: rolePlan.builders,
    specialists: rolePlan.specialists,
    allowCombined,
  });
  if (roleErrors.length > 0) {
    throw new JobError(
      "invalid_roles",
      `invalid role assignment: ${roleErrors.join("; ")}`,
    );
  }
  const agents = planAgents(rolePlan);
  if (agents.length === 0) {
    throw new JobError("no_agents", "no agents assigned");
  }
  return missionAssignmentSchema.parse({
    goal: input.goal?.trim() || `Run ${workflowId}`,
    ...(input.acceptance?.trim()
      ? { acceptance: input.acceptance.trim() }
      : {}),
    packDir: loaded.pack.metadata.name,
    workflow: workflowId,
    manager,
    sellers: rolePlan.sellers,
    builders: rolePlan.builders,
    specialists: rolePlan.specialists,
    agents,
    allowCombined,
    mode: input.runMode ?? "DRY_RUN",
    createdAt: new Date().toISOString(),
    createdBy: origin.actor,
  }) as Record<string, unknown>;
}

async function resolveEvidence(
  store: Store,
  input: StartJobInput,
): Promise<string | undefined> {
  if (input.evidenceText !== undefined) {
    if (input.evidenceText.length > 200_000) {
      throw new JobError(
        "evidence_too_large",
        "evidenceText must be under 200k characters",
      );
    }
    return input.evidenceText.trim() || undefined;
  }
  if (!input.evidenceArtifactId) {
    return undefined;
  }
  const artifact = await store.artifactStore.findById(input.evidenceArtifactId);
  if (!artifact) {
    throw new JobError(
      "artifact_not_found",
      "evidence artifact not found",
      404,
    );
  }
  const blob = await store.blobs.findById(artifact.blobId);
  if (!blob) {
    throw new JobError("blob_not_found", "evidence blob not found", 404);
  }
  try {
    const bytes = await store.blobClient.get(blob.storageKey);
    return new TextDecoder().decode(bytes);
  } catch {
    throw new JobError(
      "artifact_unavailable",
      "evidence content unavailable in this blob backend",
      409,
    );
  }
}

function resolvePackDir(
  repoRoot: string,
  input: string,
  allowOutside: boolean,
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new JobError("pack_required", "packDir is required");
  }
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : trimmed.replace(/\\/g, "/").startsWith("packs/")
      ? path.resolve(repoRoot, trimmed)
      : path.resolve(repoRoot, "packs", trimmed);
  if (!allowOutside) {
    const packsRoot = path.resolve(repoRoot, "packs");
    const prefix = packsRoot.endsWith(path.sep)
      ? packsRoot
      : `${packsRoot}${path.sep}`;
    if (!resolved.startsWith(prefix)) {
      throw new JobError("pack_outside_root", "packDir must be inside packs/");
    }
  }
  return resolved;
}

function projectRef(project: ProjectTarget): {
  id: string;
  name: string;
  path: string;
} {
  return { id: project.id, name: project.name, path: project.path };
}

/** The persisted subset of an origin; the actor only lives in mission/op log. */
function toRunOrigin(origin: JobOriginRecord): RunOrigin {
  return {
    kind: origin.kind,
    ...(origin.triggerId ? { triggerId: origin.triggerId } : {}),
    ...(origin.triggerRunId ? { triggerRunId: origin.triggerRunId } : {}),
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function parseCoder(value: unknown): CoderId | undefined {
  return value === "dsh" ||
    value === "codex" ||
    value === "opencode" ||
    value === "command"
    ? value
    : undefined;
}

/**
 * Precedence: explicit caller/pack value > `KIT_REPAIR_ROUNDS` > 2.
 * The environment is a default for operators, not a silent cap.
 */
export function resolveRepairRounds(
  explicit: unknown,
  env: Record<string, string | undefined> = process.env,
): number {
  return clampInt(explicit, 0, 5, envRepairRounds(env));
}

export function envRepairRounds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.KIT_REPAIR_ROUNDS;
  if (raw === undefined || raw === "") {
    return 2;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampInt(parsed, 0, 5, 2) : 2;
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function resolveBudgetSpec(input: StartJobInput): RunBudgetSpec | undefined {
  if (input.budgetCny === undefined) {
    return input.budget;
  }
  const base = input.budget ?? {};
  return {
    ...base,
    run: { ...base.run, cny: input.budgetCny },
  };
}

async function admitRunOrThrow(
  store: Store,
  input: AdmitRunInput,
): Promise<void> {
  const admitted = await store.budgetService.admitRun(input);
  if (!admitted.ok) {
    throw new JobError(
      "budget_exceeded",
      admitted.reason ?? "budget exceeded",
      409,
    );
  }
}

function estimateWorkflowBudget(
  loaded: Extract<Awaited<ReturnType<typeof loadPack>>, { ok: true }>,
  workflowId: string,
): { estimateCnyMicro: number; estimateTokens: number } {
  const report = simulatePack(loaded);
  const workflow = report.workflows.find((item) => item.id === workflowId);
  let cny = 0;
  let tokens = 0;
  for (const stage of workflow?.stages ?? []) {
    cny += stage.estimatedCostCny;
    tokens += stage.estimatedInputTokens + stage.estimatedOutputTokens;
  }
  return {
    estimateCnyMicro: cnyToMicro(cny),
    estimateTokens: tokens,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function iso(value: string | Date | null): string {
  if (!value) {
    return new Date(0).toISOString();
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function isTerminal(status: string): boolean {
  return ["succeeded", "failed", "cancelled", "completed"].includes(status);
}

interface OriginJobRow {
  origin_kind: string | null;
  trigger_id: string | null;
  trigger_run_id: string | null;
}

interface IterationJobRow extends OriginJobRow {
  iteration_id: string;
  goal: string | null;
  status: string;
  phase: string;
  run_mode: string;
  workflow_id: string | null;
  started_at: string | Date;
  updated_at: string | Date;
  finished_at: string | Date | null;
}

interface RunJobRow extends OriginJobRow {
  run_id: string;
  workflow_id: string;
  run_mode: string;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
}

/** Rows written before the origin migration read back as `unknown`. */
function originSummary(row: OriginJobRow): {
  originKind: RunOriginKind;
  triggerId: string | null;
  triggerRunId: string | null;
} {
  return {
    originKind: (row.origin_kind as RunOriginKind | null) ?? "unknown",
    triggerId: row.trigger_id ?? null,
    triggerRunId: row.trigger_run_id ?? null,
  };
}
