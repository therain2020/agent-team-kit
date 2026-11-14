import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  type AutopilotConfig,
  type AutopilotSchedule,
  cnyToMicro,
  eventEnvelopeSchema,
  newId,
  resolveKillSwitch,
  utcDayKey,
} from "@kit/core";
import { StoreEvolutionRepository, runEvolutionCycle } from "@kit/evolution";
import {
  findApprovalRequest,
  findDecisionForRequest,
  recordDecision,
} from "@kit/manager";
import { getActiveAutonomyPreset, getOpsGate } from "@kit/ops";
import {
  type LoadedPack,
  buildPackRun,
  loadPack,
  simulatePack,
} from "@kit/pack";
import { initStore, loadStoreConfig, withStoreLock } from "@kit/store";
import { createTemporalClient, taskQueue } from "@kit/workflow";
import { nextCronOccurrence } from "./cron";
import { applyAutonomyPreset } from "./preset";
import { type AutopilotState, ensureState, saveState } from "./state";

const WORKSPACE_ID = "default";
const TICK_MS = 30_000;
const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;

export interface TickResult {
  packs: number;
  enabled: number;
  launched: Array<{ pack: string; workflow: string; runId: string }>;
  autoApproved: string[];
  aborted: string[];
  errors: string[];
  nightMode?: boolean;
  nightModeReason?: string;
  blocked?: { scope: string; target: string; reason: string };
}

interface PackContext {
  dirName: string;
  dir: string;
  loaded: LoadedPack;
  config: AutopilotConfig;
}

export async function runAutopilotTick(
  options: { repoRoot?: string; now?: Date; dryRun?: boolean } = {},
): Promise<TickResult> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const now = options.now ?? new Date();
  const result: TickResult = {
    packs: 0,
    enabled: 0,
    launched: [],
    autoApproved: [],
    aborted: [],
    errors: [],
  };

  if (process.env.KIT_AUTOPILOT_DISABLED === "1") {
    return result;
  }

  const packs = await loadAutopilotPacks(repoRoot);
  result.packs = packs.length;
  const configuredRoot = process.env.KIT_BLOB_ROOT;
  const blobRoot = configuredRoot
    ? path.isAbsolute(configuredRoot)
      ? configuredRoot
      : path.resolve(repoRoot, configuredRoot)
    : path.join(repoRoot, ".tmp", "blobs");
  const store = await initStore(
    loadStoreConfig({ ...process.env, KIT_BLOB_ROOT: blobRoot }),
  );
  const activeRuns = await store.runs.list({ limit: 100 });
  const runningWorkflows = new Set(
    activeRuns
      .filter((run) => run.status === "running" || run.status === "paused")
      .map((run) => run.workflowId),
  );
  let temporal: Awaited<ReturnType<typeof createTemporalClient>> | undefined;
  const gate = await getOpsGate(store, now, WORKSPACE_ID);
  if (gate.readOnly) {
    result.nightMode = true;
    result.nightModeReason = gate.reason ?? "night mode";
  }
  const preset = await getActiveAutonomyPreset(store, WORKSPACE_ID);

  try {
    const hit = resolveKillSwitch(await store.killSwitches.listActive(), {
      workspaceId: WORKSPACE_ID,
    });
    if (hit) {
      result.blocked = {
        scope: hit.scope,
        target: hit.target,
        reason: hit.reason,
      };
      return result;
    }

    const acquired = await withStoreLock(
      store,
      `kit:autopilot:${WORKSPACE_ID}`,
      async () => {
        for (const pack of packs) {
          try {
            const effective: PackContext = preset
              ? { ...pack, config: applyAutonomyPreset(pack.config, preset) }
              : pack;
            const state = await ensureState(
              store.autopilotState,
              WORKSPACE_ID,
              pack.dirName,
              pack.config.enabled,
              now,
            );
            // The preset enables the loop at runtime without persisting
            // enabled=true, so rollback needs no state surgery.
            if (!state.enabled && !effective.config.enabled) {
              state.lastTickAt = now.toISOString();
              if (!(await saveState(store.autopilotState, state))) {
                result.errors.push(
                  `${pack.dirName}: state version conflict (disabled tick)`,
                );
              }
              continue;
            }
            result.enabled += 1;

            if (!gate.readOnly) {
              await processSchedules({
                pack: effective,
                state,
                now,
                runningWorkflows,
                dryRun: options.dryRun ?? false,
                store,
                result,
                getTemporal: async () => {
                  temporal ??= await createTemporalClient();
                  return temporal;
                },
              });

              await processIterations({
                pack: effective,
                state,
                now,
                dryRun: options.dryRun ?? false,
                store,
                result,
                getTemporal: async () => {
                  temporal ??= await createTemporalClient();
                  return temporal;
                },
              });

              await processAutoApprovals({
                pack: effective,
                state,
                now,
                store,
                result,
                getTemporal: async () => {
                  temporal ??= await createTemporalClient();
                  return temporal;
                },
              });

              await processEvolution({
                pack: effective,
                state,
                now,
                dryRun: options.dryRun ?? false,
                store,
                result,
              });
            }

            state.lastTickAt = now.toISOString();
            if (!(await saveState(store.autopilotState, state))) {
              result.errors.push(
                `${pack.dirName}: state version conflict (tick)`,
              );
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            result.errors.push(`${pack.dirName}: ${message}`);
          }
        }
        return true;
      },
    );
    if (acquired === null) {
      result.errors.push("autopilot tick skipped: another tick holds the lock");
    }
  } finally {
    if (temporal) {
      await temporal.connection.close();
    }
    await store.close();
  }

  return result;
}

export async function startAutopilotDaemon(
  options: { repoRoot?: string; intervalMs?: number } = {},
): Promise<() => void> {
  const interval = options.intervalMs ?? TICK_MS;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const loop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    try {
      const result = await runAutopilotTick({ repoRoot: options.repoRoot });
      console.log(
        `[autopilot] packs=${result.packs} enabled=${result.enabled} launched=${result.launched.length} approved=${result.autoApproved.length} errors=${result.errors.length}`,
      );
      for (const error of result.errors) {
        console.error(`[autopilot] ${error}`);
      }
    } catch (error) {
      console.error(
        `[autopilot] tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    timer = setTimeout(loop, interval);
  };

  void loop();
  return () => {
    stopping = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}

async function loadAutopilotPacks(repoRoot: string): Promise<PackContext[]> {
  const packsRoot = path.join(repoRoot, "packs");
  if (!existsSync(packsRoot)) {
    return [];
  }
  const entries = await readdir(packsRoot, { withFileTypes: true });
  const packs: PackContext[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(packsRoot, entry.name);
    if (!existsSync(path.join(dir, "team.yaml"))) {
      continue;
    }
    const loaded = await loadPack(dir);
    if (!loaded.ok || !loaded.autopilot) {
      continue;
    }
    packs.push({
      dirName: entry.name,
      dir,
      loaded,
      config: loaded.autopilot,
    });
  }
  return packs;
}

async function processSchedules(input: {
  pack: PackContext;
  state: AutopilotState;
  now: Date;
  runningWorkflows: Set<string>;
  dryRun: boolean;
  store: Awaited<ReturnType<typeof initStore>>;
  result: TickResult;
  getTemporal: () => Promise<Awaited<ReturnType<typeof createTemporalClient>>>;
}): Promise<boolean> {
  const { pack, state, now, result } = input;
  let changed = false;
  const simulation = simulatePack(pack.loaded);

  for (const schedule of pack.config.schedules) {
    const nextKey = schedule.id;
    const nextValue = state.nextRuns[nextKey];
    if (!nextValue) {
      try {
        state.nextRuns[nextKey] = nextCronOccurrence(
          schedule.cron,
          now,
          pack.config.timezone,
        ).toISOString();
        changed = true;
      } catch (error) {
        result.errors.push(
          `${pack.dirName}/${schedule.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }

    const nextAt = new Date(nextValue);
    if (Number.isNaN(nextAt.getTime()) || nextAt.getTime() > now.getTime()) {
      continue;
    }

    try {
      state.nextRuns[nextKey] = nextCronOccurrence(
        schedule.cron,
        now,
        pack.config.timezone,
      ).toISOString();
    } catch (error) {
      result.errors.push(
        `${pack.dirName}/${schedule.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    changed = true;

    if (input.runningWorkflows.has(schedule.workflow)) {
      result.errors.push(
        `${pack.dirName}/${schedule.id}: skipped, previous run still active`,
      );
      continue;
    }

    const simulated = simulation.workflows.find(
      (workflow) => workflow.id === schedule.workflow,
    );
    const estimate = simulated?.totalCostCny ?? 0;
    const estimateTokens =
      simulated?.stages.reduce(
        (sum, stage) =>
          sum + stage.estimatedInputTokens + stage.estimatedOutputTokens,
        0,
      ) ?? 0;
    if (!withinBudget(state, schedule, estimate)) {
      result.errors.push(
        `${pack.dirName}/${schedule.id}: skipped, daily budget reached`,
      );
      continue;
    }

    if (input.dryRun) {
      result.launched.push({
        pack: pack.dirName,
        workflow: schedule.workflow,
        runId: "dry-run",
      });
      continue;
    }

    try {
      const inputFile = schedule.inputFile
        ? path.isAbsolute(schedule.inputFile)
          ? schedule.inputFile
          : path.resolve(pack.dir, schedule.inputFile)
        : undefined;
      const built = await buildPackRun(pack.loaded, {
        workflow: schedule.workflow,
        inputFile,
        runMode: schedule.mode,
        stub: process.env.KIT_MODEL_MODE === "stub",
      });
      const admitted = await input.store.budgetService.admitRun({
        workspaceId: built.input.workspaceId,
        runId: built.input.runId,
        stages: built.input.stages.map((stage) => ({
          stageId: stage.stageId,
          stageName: stage.stageName,
          ...(stage.agentId ? { agentId: stage.agentId } : {}),
        })),
        estimateCnyMicro: cnyToMicro(estimate),
        estimateTokens,
      });
      if (!admitted.ok) {
        result.errors.push(
          `${pack.dirName}/${schedule.id}: skipped, ${admitted.reason ?? "budget exceeded"}`,
        );
        continue;
      }
      const timestamp = new Date().toISOString();
      const event = eventEnvelopeSchema.parse({
        eventId: built.input.eventId,
        type: built.eventType,
        schemaVersion: "1.0",
        occurredAt: timestamp,
        receivedAt: timestamp,
        workspaceId: built.input.workspaceId,
        idempotencyKey: `autopilot:${pack.dirName}:${schedule.id}:${built.input.runId}`,
        traceId: newId("trc"),
        payloadRef: "memory://autopilot",
      });
      await input.store.events.insert(event);

      const { client } = await input.getTemporal();
      await client.workflow.start("packWorkflow", {
        taskQueue,
        workflowId: `pack-${built.input.runId}`,
        args: [built.input],
      });
      state.runsToday += 1;
      state.spentToday =
        Math.round((state.spentToday + estimate) * 10000) / 10000;
      input.runningWorkflows.add(schedule.workflow);
      result.launched.push({
        pack: pack.dirName,
        workflow: schedule.workflow,
        runId: built.input.runId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastError = message;
      result.errors.push(`${pack.dirName}/${schedule.id}: ${message}`);
    }
  }

  return changed;
}

async function processIterations(input: {
  pack: PackContext;
  state: AutopilotState;
  now: Date;
  dryRun: boolean;
  store: Awaited<ReturnType<typeof initStore>>;
  result: TickResult;
  getTemporal: () => Promise<Awaited<ReturnType<typeof createTemporalClient>>>;
}): Promise<boolean> {
  const { pack, state, now, store, result } = input;
  let changed = false;

  for (const iteration of pack.config.iterations) {
    if (!pack.loaded.iteration) {
      result.errors.push(
        `${pack.dirName}/${iteration.id}: iteration.yaml is missing`,
      );
      continue;
    }
    const key = `__iteration:${iteration.id}`;
    const nextValue = state.nextRuns[key];
    if (!nextValue) {
      try {
        state.nextRuns[key] = nextCronOccurrence(
          iteration.cron,
          now,
          pack.config.timezone,
        ).toISOString();
        changed = true;
      } catch (error) {
        result.errors.push(
          `${pack.dirName}/${iteration.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }

    const nextAt = new Date(nextValue);
    if (Number.isNaN(nextAt.getTime()) || nextAt.getTime() > now.getTime()) {
      continue;
    }
    const slot = nextValue;

    try {
      state.nextRuns[key] = nextCronOccurrence(
        iteration.cron,
        now,
        pack.config.timezone,
      ).toISOString();
    } catch (error) {
      result.errors.push(
        `${pack.dirName}/${iteration.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    changed = true;

    if (
      iteration.budget?.dailyRuns !== undefined &&
      state.runsToday >= iteration.budget.dailyRuns
    ) {
      result.errors.push(
        `${pack.dirName}/${iteration.id}: skipped, daily run budget reached`,
      );
      continue;
    }

    if (input.dryRun) {
      result.launched.push({
        pack: pack.dirName,
        workflow: `iteration:${iteration.id}`,
        runId: "dry-run",
      });
      continue;
    }

    if (iteration.budget?.dailyCostCny !== undefined) {
      const spent = await daySpendCny(store, WORKSPACE_ID, now);
      if (spent >= iteration.budget.dailyCostCny) {
        result.errors.push(
          `${pack.dirName}/${iteration.id}: skipped, daily cost budget reached`,
        );
        continue;
      }
    }

    const dedupeKey = `autopilot:${pack.dirName}:${iteration.id}:${slot}`;
    const workflowId = `iteration-${WORKSPACE_ID}-${hash(dedupeKey)}`;
    const iterationId = newId("it");
    try {
      const admitted = await store.budgetService.admitRun({
        workspaceId: WORKSPACE_ID,
        runId: iterationId,
        estimateCnyMicro: 0,
        estimateTokens: 0,
      });
      if (!admitted.ok) {
        result.errors.push(
          `${pack.dirName}/${iteration.id}: skipped, ${admitted.reason ?? "budget exceeded"}`,
        );
        continue;
      }

      const { client } = await input.getTemporal();
      const handle = client.workflow.getHandle(workflowId);
      try {
        await handle.describe();
        result.errors.push(
          `${pack.dirName}/${iteration.id}: skipped, already launched for slot ${slot}`,
        );
        continue;
      } catch {
        // no existing workflow for this slot
      }
      await client.workflow.start("iterationWorkflow", {
        taskQueue,
        workflowId,
        workflowIdConflictPolicy: "USE_EXISTING",
        args: [
          {
            iterationId,
            workspaceId: WORKSPACE_ID,
            packDir: pack.dir,
            goal: iteration.goal,
            ...(iteration.acceptance
              ? { acceptance: iteration.acceptance }
              : {}),
            maxTasks: iteration.maxTasks,
            maxRepair: iteration.maxRepair,
            runMode: iteration.mode,
            applyMode: iteration.mode === "LIVE" ? iteration.applyMode : "none",
            ...(iteration.coder ? { coder: iteration.coder } : {}),
            stub: false,
            dedupeKey,
          },
        ],
      });
      state.runsToday += 1;
      result.launched.push({
        pack: pack.dirName,
        workflow: `iteration:${iteration.id}`,
        runId: iterationId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastError = message;
      result.errors.push(`${pack.dirName}/${iteration.id}: ${message}`);
    }
  }

  return changed;
}

async function processAutoApprovals(input: {
  pack: PackContext;
  state: AutopilotState;
  now: Date;
  store: Awaited<ReturnType<typeof initStore>>;
  result: TickResult;
  getTemporal: () => Promise<Awaited<ReturnType<typeof createTemporalClient>>>;
}): Promise<boolean> {
  const { pack, state, now, store, result } = input;
  const policy = pack.config.approval?.autoApprove;
  if (!policy?.enabled) {
    return false;
  }

  let changed = false;
  const paused = await store.runs.list({ status: "paused", limit: 50 });
  for (const run of paused) {
    if (run.workflowId !== undefined) {
      const workflow = pack.loaded.workflows.find(
        (item) => item.id === run.workflowId,
      );
      if (!workflow) {
        continue;
      }
    }

    const approval = await findApprovalRequest(store, run.runId);
    if (!approval) {
      continue;
    }

    // Budget exceptions need an operator decision and a limit increase;
    // auto-approving them would loop forever.
    if (approval.requestType === "budget_exceeded") {
      continue;
    }

    if (
      approval.expiresAt &&
      new Date(approval.expiresAt).getTime() < now.getTime()
    ) {
      if (policy.onTimeout === "abort") {
        const existing = await findDecisionForRequest(
          store,
          run.runId,
          approval.requestId,
        );
        if (!existing) {
          await recordDecision(
            store,
            run.runId,
            "abort",
            "auto-aborted: approval request timed out",
            { requestId: approval.requestId, actor: "policy:autopilot" },
          );
        }
        await signalApproval(input, run.runId, "abort", approval.requestId);
        result.aborted.push(run.runId);
        changed = true;
      }
      continue;
    }

    if (RISK_RANK[approval.riskClass] > RISK_RANK[policy.maxRisk]) {
      continue;
    }
    const cost = await runCost(store, run.runId);
    if (policy.maxRunCostCny !== undefined && cost > policy.maxRunCostCny) {
      continue;
    }

    const existing = await findDecisionForRequest(
      store,
      run.runId,
      approval.requestId,
    );
    if (!existing) {
      await recordDecision(
        store,
        run.runId,
        "approve",
        `auto-approved by autopilot (risk ${approval.riskClass}, cost ${cost.toFixed(4)} CNY)`,
        { requestId: approval.requestId, actor: "policy:autopilot" },
      );
    }
    await signalApproval(input, run.runId, "approve", approval.requestId);
    result.autoApproved.push(run.runId);
    changed = true;
  }
  return changed;
}

async function signalApproval(
  input: {
    getTemporal: () => Promise<
      Awaited<ReturnType<typeof createTemporalClient>>
    >;
  },
  runId: string,
  decision: "approve" | "abort",
  requestId: string,
): Promise<void> {
  const { client } = await input.getTemporal();
  const handle = client.workflow.getHandle(`pack-${runId}`);
  await handle.signal("approval", {
    decision,
    note: "autopilot policy",
    requestId,
  });
}

async function processEvolution(input: {
  pack: PackContext;
  state: AutopilotState;
  now: Date;
  dryRun: boolean;
  store: Awaited<ReturnType<typeof initStore>>;
  result: TickResult;
}): Promise<boolean> {
  const config = input.pack.config.evolution;
  if (!config?.enabled) {
    return false;
  }
  const key = "__evolution";
  const nextValue = input.state.nextRuns[key];
  if (!nextValue) {
    input.state.nextRuns[key] = addCadence(input.now, config.cadence);
    return true;
  }
  if (new Date(nextValue).getTime() > input.now.getTime()) {
    return false;
  }
  input.state.nextRuns[key] = addCadence(input.now, config.cadence);

  if (!config.evidenceFile) {
    input.result.errors.push(
      `${input.pack.dirName}: evolution enabled but evidenceFile is missing`,
    );
    return true;
  }
  if (input.dryRun) {
    return true;
  }

  try {
    const evidenceFile = path.isAbsolute(config.evidenceFile)
      ? config.evidenceFile
      : path.resolve(input.pack.dir, config.evidenceFile);
    const variantsRoot = path.resolve(input.pack.dir, "..", "variants");
    const archivePath = path.join(variantsRoot, "archive.jsonl");
    const cyclesPath = path.join(variantsRoot, "cycles.jsonl");
    const statePath = path.join(variantsRoot, "state.json");
    const repo = new StoreEvolutionRepository(input.store, {
      variantsRoot,
      archivePath,
      cyclesPath,
      statePath,
    });
    const record = await runEvolutionCycle({
      packDir: input.pack.dir,
      agentId: config.agent,
      inputFile: evidenceFile,
      autoApply: config.autoApply,
      budgetCny: config.budgetCny,
      variantsRoot,
      archivePath,
      cyclesPath,
      statePath,
      repo,
    });
    console.log(
      `[autopilot] evolution cycle ${record.cycleId} decision=${record.decision} candidatePass=${record.candidatePass}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.state.lastError = message;
    input.result.errors.push(
      `${input.pack.dirName}: evolution failed: ${message}`,
    );
  }
  return true;
}

function withinBudget(
  state: AutopilotState,
  schedule: AutopilotSchedule,
  estimateCny: number,
): boolean {
  const budget = schedule.budget;
  if (!budget) {
    return true;
  }
  if (budget.dailyRuns !== undefined && state.runsToday >= budget.dailyRuns) {
    return false;
  }
  if (
    budget.dailyCostCny !== undefined &&
    state.spentToday + estimateCny > budget.dailyCostCny
  ) {
    return false;
  }
  return true;
}

async function runCost(
  store: Awaited<ReturnType<typeof initStore>>,
  runId: string,
): Promise<number> {
  const artifacts = await store.artifactStore.listByRun(runId);
  let total = 0;
  for (const artifact of artifacts) {
    const manifest = await store.manifests.get(artifact.manifestId);
    total += manifest?.cost.amount ?? 0;
  }
  return total;
}

async function daySpendCny(
  store: Awaited<ReturnType<typeof initStore>>,
  workspaceId: string,
  now: Date,
): Promise<number> {
  const dayKey = utcDayKey(now);
  const budgets = await store.budgetService.listBudgets({
    workspaceId,
    scope: "day",
    limit: 10,
  });
  const day = budgets.find((budget) => budget.targetKey === dayKey);
  return day ? day.spentCnyMicro / 1_000_000 : 0;
}

function addCadence(now: Date, cadence: "daily" | "weekly"): string {
  const days = cadence === "weekly" ? 7 : 1;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
