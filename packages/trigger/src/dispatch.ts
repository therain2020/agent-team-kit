import path from "node:path";
import {
  type DegradedMode,
  type KillSwitch,
  activeModeFor,
  cnyToMicro,
  isExecutionBlocked,
  newId,
  resolveKillSwitch,
} from "@kit/core";
import {
  type JobOriginKind,
  type StartJobInput,
  dedupeRunId,
  startJob as defaultStartJob,
} from "@kit/job";
import { type OpsGate, getOpsGate as defaultGetOpsGate } from "@kit/ops";
import { type LoadedPack, loadPack, simulatePack } from "@kit/pack";
import {
  type AdmitRunInput,
  type AdmitRunResult,
  type TriggerRunRecord,
  appendOp,
  type initStore,
} from "@kit/store";
import {
  type BlockingGate,
  type DispatchGate,
  type EventRoute,
  type FireTriggerInput,
  type Trigger,
  type TriggerBudget,
  type TriggerRegistry,
  type TriggerResult,
  type TriggerRunStatus,
  type TriggerUsage,
  USE_EXISTING,
} from "./types";

type Store = Awaited<ReturnType<typeof initStore>>;

export interface FireTriggerDeps {
  store: Store;
  repoRoot: string;
  workspaceId?: string;
  now?: Date;
  env?: Record<string, string | undefined>;
  registry?: TriggerRegistry;
  /** Injection points kept explicit so gate-order contract tests can observe. */
  startJobFn?: typeof defaultStartJob;
  admitRunFn?: (input: AdmitRunInput) => Promise<AdmitRunResult>;
  killSwitchFn?: typeof resolveKillSwitch;
  opsGateFn?: typeof defaultGetOpsGate;
  onGate?: (gate: DispatchGate) => void;
}

interface ResolvedRoute {
  trigger: Trigger;
  route: EventRoute;
}

/**
 * The only trigger dispatch entry (96 §3.3). Adapters produce firings; this
 * function owns the fixed D-66/96 §4 gate order and the single `startJob`
 * write. No adapter may call `startJob` or `workflow.start` itself.
 */
export async function fireTrigger(
  input: FireTriggerInput,
  deps: FireTriggerDeps,
): Promise<TriggerResult> {
  const store = deps.store;
  const repoRoot = deps.repoRoot;
  const workspaceId = deps.workspaceId ?? "default";
  const now = deps.now ?? new Date();
  const env = deps.env ?? process.env;
  const gates: DispatchGate[] = [];
  const emit = (gate: DispatchGate): void => {
    gates.push(gate);
    deps.onGate?.(gate);
  };
  const base: Omit<TriggerResult, "dispatch" | "status" | "gate" | "reason"> = {
    triggerId: input.triggerId,
    triggerRunId: null,
    jobId: null,
    kind: null,
    estimateCny: 0,
    gates,
  };

  const resolved = await resolveRoute(input, deps);
  if ("error" in resolved) {
    return { ...base, ...resolved.error, gates };
  }
  const { trigger, route } = resolved;
  const triggerKind = trigger.kind;
  if (route.jobKind === "evolution") {
    // Mapped for the read model; executable scheduling lands with #95 (T4).
    return {
      ...base,
      status: "failed",
      dispatch: "FAILED",
      gate: null,
      reason: "evolution routing is delivered by #95",
    };
  }

  // Gate 1 — kill switch.
  emit("kill-switch");
  const killSwitchFn = deps.killSwitchFn ?? resolveKillSwitch;
  const hit = killSwitchFn(await store.killSwitches.listActive(), {
    workspaceId,
  });
  if (hit) {
    return skipped(base, "kill-switch", killSwitchLabel(hit));
  }

  // Gate 2 — degraded read-only / night mode.
  emit("degraded");
  const blocked = await degradedReason(store, deps, now, workspaceId, input);
  if (blocked) {
    return skipped(base, "degraded", blocked);
  }

  // Gate 3 — dedupe: trigger slot, then same workflow already active.
  emit("dedupe");
  const existing = await store.triggerRuns.findByDedupeKey(
    trigger.triggerId,
    input.dedupeKey,
  );
  // A failed launch did not create a job, so the same slot may retry; every
  // other status means the firing already owns (or is about to own) a job.
  const resumeTriggerRunId =
    existing?.status === "failed" ? existing.triggerRunId : null;
  if (existing && !resumeTriggerRunId) {
    return {
      ...base,
      triggerRunId: existing.triggerRunId,
      jobId: existing.jobId,
      status: "existing",
      dispatch: USE_EXISTING,
      gate: "dedupe",
      reason: `slot already fired (${input.dedupeKey})`,
      estimateCny: existing.estimateCny,
    };
  }
  if (route.jobKind === "packRun" && route.workflow) {
    const activeRuns = await store.runs.list({ limit: 200 });
    const busy = activeRuns.some(
      (run) =>
        run.workflowId === route.workflow &&
        (run.status === "running" || run.status === "paused"),
    );
    if (busy) {
      return skipped(base, "dedupe", "workflow already active");
    }
  }

  // Gate 4 — trigger budget (TriggerRun + runs/iterations + manifests, UTC day).
  emit("trigger-budget");
  const budget = resolveTriggerBudget(route, triggerKind, env);
  const estimateCny = await estimateRouteCost(route, repoRoot);
  if (budget) {
    const usage = await loadTriggerUsage(
      store,
      workspaceId,
      trigger,
      now,
      budget.dailyCostCny !== undefined,
    );
    const over = triggerBudgetSkip(budget, usage, estimateCny);
    if (over) {
      return { ...skipped(base, "trigger-budget", over), estimateCny };
    }
  }

  // Gate 5 — budget ledger admission (four-level hard caps).
  emit("budget-ledger");
  const plannedRunId =
    input.runId ??
    (route.jobKind === "packRun" ? dedupeRunId(input.dedupeKey) : newId("it"));
  let admitted: AdmitRunResult;
  try {
    admitted = await admitRoute(
      store,
      deps,
      route,
      repoRoot,
      workspaceId,
      plannedRunId,
      estimateCny,
    );
  } catch (error) {
    return {
      ...base,
      estimateCny,
      status: "failed",
      dispatch: "FAILED",
      gate: "budget-ledger",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!admitted.ok) {
    return {
      ...skipped(base, "budget-ledger", admitted.reason ?? "budget exceeded"),
      estimateCny,
    };
  }

  // TriggerRun ids are per firing (one event may match several workflows).
  // The row is written after `startJob`; the job service already dedupes the
  // same key, so a crash between the two replays as USE_EXISTING.
  const triggerRunId = resumeTriggerRunId ?? input.triggerRunId ?? newId("trg");
  const timestamp = now.toISOString();

  // Gate 6 — the single job write entry.
  emit("start-job");
  const startJobFn = deps.startJobFn ?? defaultStartJob;
  const originKind = input.originKind ?? triggerKind;
  let failureMessage: string | null = null;
  const started = await startJobFn(
    store,
    buildStartJobInput(
      input,
      trigger,
      route,
      originKind,
      plannedRunId,
      triggerRunId,
      repoRoot,
      workspaceId,
    ),
    {
      repoRoot,
      ...(route.allowPackOutsideRoot ? { allowPackOutsideRoot: true } : {}),
    },
  ).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    failureMessage = message;
    emit("write-back");
    const failedAt = new Date().toISOString();
    if (resumeTriggerRunId) {
      await store.triggerRuns
        .finish(triggerRunId, null, "failed", estimateCny, message, failedAt)
        .catch(() => false);
    } else {
      await store.triggerRuns
        .create({
          triggerRunId,
          workspaceId,
          triggerId: trigger.triggerId,
          kind: triggerKind,
          routeId: route.routeId,
          jobKind: route.jobKind,
          dedupeKey: input.dedupeKey,
          jobId: null,
          status: "failed",
          launchedAt: timestamp,
          estimateCny,
          payloadRef: input.payloadRef ?? null,
          lastError: message,
          createdAt: timestamp,
          updatedAt: failedAt,
        })
        .catch(() => false);
    }
    // Failed launches are auditable even though no job row exists.
    await appendOp(store, {
      workspaceId,
      entityKind: "trigger_run",
      entityId: triggerRunId,
      op: "trigger.run.failed",
      actor: input.actor ?? trigger.actor,
      origin: originFor(triggerKind),
      payload: {
        triggerId: trigger.triggerId,
        dedupeKey: input.dedupeKey,
        reason: message,
      },
      createdAt: new Date().toISOString(),
    }).catch(() => undefined);
    return null;
  });
  if (!started) {
    return {
      ...base,
      triggerRunId,
      status: "failed",
      dispatch: "FAILED",
      gate: "start-job",
      reason: failureMessage ?? "startJob failed",
      estimateCny,
    };
  }

  // Gate 7 — write back the job id and terminal status.
  emit("write-back");
  const status: TriggerRunStatus = started.deduped ? "existing" : "started";
  const writeBackAt = new Date().toISOString();
  const record: TriggerRunRecord = {
    triggerRunId,
    workspaceId,
    triggerId: trigger.triggerId,
    kind: triggerKind,
    routeId: route.routeId,
    jobKind: route.jobKind,
    dedupeKey: input.dedupeKey,
    jobId: started.jobId,
    status,
    launchedAt: timestamp,
    estimateCny,
    payloadRef: input.payloadRef ?? null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: writeBackAt,
  };
  try {
    if (resumeTriggerRunId) {
      await store.triggerRuns.finish(
        triggerRunId,
        started.jobId,
        status,
        estimateCny,
        null,
        writeBackAt,
      );
    } else if (!(await store.triggerRuns.create(record))) {
      const raced = await store.triggerRuns.findByDedupeKey(
        trigger.triggerId,
        input.dedupeKey,
      );
      return {
        ...base,
        triggerRunId: raced?.triggerRunId ?? triggerRunId,
        jobId: raced?.jobId ?? started.jobId,
        kind: started.kind,
        status: "existing",
        dispatch: USE_EXISTING,
        gate: "write-back",
        reason: "slot already fired",
        estimateCny: raced?.estimateCny ?? estimateCny,
      };
    }
  } catch (error) {
    // The job is already running: surface the audit gap without a false failure.
    return {
      ...base,
      triggerRunId,
      jobId: started.jobId,
      kind: started.kind,
      status: started.deduped ? "existing" : "started",
      dispatch: started.deduped ? USE_EXISTING : "STARTED",
      gate: "write-back",
      reason: `trigger run write-back failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      estimateCny,
      job: started,
      runMode: started.runMode,
    };
  }

  return {
    ...base,
    triggerRunId,
    jobId: started.jobId,
    kind: started.kind,
    status: started.deduped ? "existing" : "started",
    dispatch: started.deduped ? USE_EXISTING : "STARTED",
    gate: "write-back",
    reason: started.deduped
      ? "job with the same dedupe key already exists"
      : null,
    estimateCny,
    job: started,
    runMode: started.runMode,
  };
}

async function resolveRoute(
  input: FireTriggerInput,
  deps: FireTriggerDeps,
): Promise<ResolvedRoute | { error: Omit<TriggerResult, "gates"> }> {
  if (input.trigger && input.route) {
    return { trigger: input.trigger, route: input.route };
  }
  const fromRegistry = deps.registry
    ? await deps.registry.resolve(input.triggerId)
    : null;
  if (!fromRegistry) {
    // No gate ran yet; report an explicit failure rather than a silent skip.
    const error: Omit<TriggerResult, "gates"> = {
      dispatch: "FAILED",
      status: "failed",
      triggerId: input.triggerId,
      triggerRunId: null,
      jobId: null,
      kind: null,
      gate: null,
      reason: `unknown trigger: ${input.triggerId}`,
      estimateCny: 0,
    };
    return { error };
  }
  return fromRegistry;
}

function skipped(
  base: Omit<TriggerResult, "dispatch" | "status" | "gate" | "reason">,
  gate: BlockingGate,
  reason: string,
): TriggerResult {
  return {
    ...base,
    status: "skipped",
    dispatch: "SKIPPED",
    gate,
    reason,
  };
}

function killSwitchLabel(hit: KillSwitch): string {
  return `kill switch ${hit.scope}/${hit.target || "*"}`;
}

function originFor(kind: Trigger["kind"]): "autopilot" | "event" | "system" {
  if (kind === "schedule") {
    return "autopilot";
  }
  if (kind === "event") {
    return "event";
  }
  return "system";
}

async function degradedReason(
  store: Store,
  deps: FireTriggerDeps,
  now: Date,
  workspaceId: string,
  input: FireTriggerInput,
): Promise<string | null> {
  const opsGateFn = deps.opsGateFn ?? defaultGetOpsGate;
  const gate: OpsGate = await opsGateFn(store, now, workspaceId);
  if (gate.readOnly) {
    return gate.reason ?? "workspace is in read-only mode";
  }

  const records = await store.degradation.listActive();
  const modes: DegradedMode[] = records.map((record) => ({
    ...record,
    exitedAt: record.exitedAt ?? undefined,
    exitReason: record.exitReason ?? undefined,
  }));
  const mode = activeModeFor(modes, workspaceId);
  if (!isExecutionBlocked(mode) || !mode) {
    return null;
  }
  await store.degradation
    .appendAudit({
      auditId: newId("daud"),
      occurredAt: now.toISOString(),
      actor: "trigger-dispatch",
      action: "blocked",
      scope: mode.scope,
      workspaceId: mode.scope === "global" ? workspaceId : mode.workspaceId,
      modeId: mode.modeId,
      detail: {
        action: "fire",
        triggerId: input.triggerId,
        dedupeKey: input.dedupeKey,
      },
    })
    .catch(() => undefined);
  return "workspace is in read-only mode";
}

export function resolveTriggerBudget(
  route: Pick<EventRoute, "budget">,
  kind: Trigger["kind"],
  env: Record<string, string | undefined> = process.env,
): TriggerBudget | undefined {
  const eventFallback = kind === "event" ? "event" : "trigger";
  const dailyRuns =
    route.budget?.dailyRuns ??
    positiveInt(env[`KIT_${eventFallback.toUpperCase()}_DAILY_RUNS`]);
  const dailyCostCny =
    route.budget?.dailyCostCny ??
    nonNegativeNumber(env[`KIT_${eventFallback.toUpperCase()}_DAILY_COST_CNY`]);
  if (dailyRuns === undefined && dailyCostCny === undefined) {
    return undefined;
  }
  return {
    ...(dailyRuns !== undefined ? { dailyRuns } : {}),
    ...(dailyCostCny !== undefined ? { dailyCostCny } : {}),
  };
}

export function triggerBudgetSkip(
  budget: TriggerBudget | undefined,
  usage: TriggerUsage,
  estimateCny: number,
): string | null {
  if (!budget) {
    return null;
  }
  if (budget.dailyRuns !== undefined && usage.runs >= budget.dailyRuns) {
    return `daily run budget reached (${usage.runs}/${budget.dailyRuns})`;
  }
  if (budget.dailyCostCny !== undefined) {
    const projected = round4(usage.costCny + estimateCny);
    if (projected > budget.dailyCostCny) {
      return `daily cost budget would be exceeded (${projected} > ${budget.dailyCostCny} CNY)`;
    }
  }
  return null;
}

export function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Trigger budget usage: TriggerRun is the T3 system of record, while the runs
 * and iteration_runs tables keep the count honest for rows written before the
 * trigger plane existed. Cost prefers manifest actuals, falling back to the
 * estimate recorded on the TriggerRun.
 */
export async function loadTriggerUsage(
  store: Store,
  workspaceId: string,
  trigger: Pick<Trigger, "triggerId">,
  now: Date,
  withCost = false,
): Promise<TriggerUsage> {
  const since = startOfUtcDay(now).toISOString();
  const [slots] = await store.sql<Array<{ count: number | string }>>`
    SELECT COUNT(*) AS count FROM trigger_runs
    WHERE workspace_id = ${workspaceId} AND trigger_id = ${trigger.triggerId}
      AND launched_at >= ${since} AND status <> 'failed'
  `;
  const [runs] = await store.sql<Array<{ count: number | string }>>`
    SELECT COUNT(*) AS count FROM runs
    WHERE workspace_id = ${workspaceId} AND trigger_id = ${trigger.triggerId}
      AND created_at >= ${since}
  `;
  const [iterations] = await store.sql<Array<{ count: number | string }>>`
    SELECT COUNT(*) AS count FROM iteration_runs
    WHERE workspace_id = ${workspaceId} AND trigger_id = ${trigger.triggerId}
      AND started_at >= ${since}
  `;
  const slotCount = Number(slots?.count ?? 0);
  const tableRuns = Number(runs?.count ?? 0) + Number(iterations?.count ?? 0);

  let costCny = 0;
  if (withCost) {
    const rows = (
      await store.triggerRuns.list(workspaceId, {
        triggerId: trigger.triggerId,
        since,
        limit: 5000,
      })
    ).filter((row) => row.status !== "failed");
    for (const row of rows) {
      const actual = row.jobId ? await runManifestCost(store, row.jobId) : 0;
      costCny += actual > 0 ? actual : row.estimateCny;
    }
  }

  return {
    runs: Math.max(slotCount, tableRuns),
    costCny: round4(costCny),
  };
}

async function runManifestCost(store: Store, runId: string): Promise<number> {
  try {
    const rows = await store.sql<Array<{ cost: unknown }>>`
      SELECT cost FROM manifests WHERE run_id = ${runId}
    `;
    let total = 0;
    for (const row of rows) {
      total += manifestAmount(row.cost);
    }
    return round4(total);
  } catch {
    return 0;
  }
}

function manifestAmount(value: unknown): number {
  if (typeof value === "string") {
    try {
      return manifestAmount(JSON.parse(value));
    } catch {
      return 0;
    }
  }
  if (typeof value === "object" && value !== null) {
    const amount = (value as { amount?: unknown }).amount;
    return typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  }
  return 0;
}

async function estimateRouteCost(
  route: EventRoute,
  repoRoot: string,
): Promise<number> {
  if (route.jobKind !== "packRun" || !route.workflow) {
    return 0;
  }
  const loaded = await loadPack(resolvePackPath(repoRoot, route.packDir));
  if (!loaded.ok) {
    return 0;
  }
  return (
    simulatePack(loaded).workflows.find(
      (workflow) => workflow.id === route.workflow,
    )?.totalCostCny ?? 0
  );
}

async function admitRoute(
  store: Store,
  deps: FireTriggerDeps,
  route: EventRoute,
  repoRoot: string,
  workspaceId: string,
  runId: string,
  estimateCny: number,
): Promise<AdmitRunResult> {
  let loaded: LoadedPack | null = null;
  if (route.jobKind === "packRun" && route.workflow) {
    const result = await loadPack(resolvePackPath(repoRoot, route.packDir));
    if (result.ok) {
      loaded = result;
    }
  }
  const workflow = loaded
    ? simulatePack(loaded).workflows.find((item) => item.id === route.workflow)
    : undefined;
  const stages =
    workflow?.stages.map((stage) => ({
      stageId: `${runId}:${stage.id}`,
      stageName: stage.id,
      ...(stage.agent ? { agentId: stage.agent } : {}),
    })) ?? [];
  const estimate = workflow
    ? workflow.stages.reduce(
        (acc, stage) => {
          acc.cny += stage.estimatedCostCny;
          acc.tokens +=
            stage.estimatedInputTokens + stage.estimatedOutputTokens;
          return acc;
        },
        { cny: 0, tokens: 0 },
      )
    : { cny: estimateCny, tokens: 0 };

  const admit: (input: AdmitRunInput) => Promise<AdmitRunResult> =
    deps.admitRunFn ??
    ((input: AdmitRunInput) => store.budgetService.admitRun(input));
  return admit({
    workspaceId,
    runId,
    ...(stages.length > 0 ? { stages } : {}),
    estimateCnyMicro: cnyToMicro(round4(estimate.cny || estimateCny)),
    estimateTokens: estimate.tokens,
  });
}

function buildStartJobInput(
  input: FireTriggerInput,
  trigger: Trigger,
  route: EventRoute,
  originKind: JobOriginKind,
  runId: string,
  triggerRunId: string,
  repoRoot: string,
  workspaceId: string,
): StartJobInput {
  const origin = {
    kind: originKind,
    triggerId: trigger.triggerId,
    triggerRunId,
    actor: input.actor ?? trigger.actor,
  } as const;

  if (route.jobKind === "iteration") {
    return {
      kind: "iteration" as const,
      packDir: route.packDir,
      goal: route.goal ?? `Trigger ${trigger.triggerId}`,
      ...(route.acceptance ? { acceptance: route.acceptance } : {}),
      ...(route.maxTasks !== undefined ? { maxTasks: route.maxTasks } : {}),
      ...(route.maxRepair !== undefined ? { maxRepair: route.maxRepair } : {}),
      ...(route.coder ? { coder: route.coder } : {}),
      ...(route.applyMode && route.runMode === "LIVE"
        ? { applyMode: route.applyMode }
        : {}),
      // The route's packDir is the variant directory when a variant is
      // selected; carrying the id stamps the effective change on the run so
      // live fitness can be attributed to it (85 §3.5).
      ...(input.variant ? { variant: input.variant } : {}),
      runMode: route.runMode,
      stub: false,
      dedupeKey: input.dedupeKey,
      runId,
      workspaceId,
      origin,
    };
  }

  return {
    kind: "packRun" as const,
    packDir: route.packDir,
    ...(route.workflow ? { workflow: route.workflow } : {}),
    ...(route.inputFile
      ? {
          inputFile: path.isAbsolute(route.inputFile)
            ? route.inputFile
            : path.resolve(
                resolvePackPath(repoRoot, route.packDir),
                route.inputFile,
              ),
        }
      : {}),
    ...(input.evidenceText !== undefined
      ? { evidenceText: input.evidenceText }
      : {}),
    ...(input.eventId ? { eventId: input.eventId } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
    runMode: route.runMode,
    stub: process.env.KIT_MODEL_MODE === "stub",
    dedupeKey: input.dedupeKey,
    runId,
    workspaceId,
    origin,
  };
}

export function resolvePackPath(repoRoot: string, packDir: string): string {
  const trimmed = packDir.trim();
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  if (trimmed.replace(/\\/g, "/").startsWith("packs/")) {
    return path.resolve(repoRoot, trimmed);
  }
  return path.resolve(repoRoot, "packs", trimmed);
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function nonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
