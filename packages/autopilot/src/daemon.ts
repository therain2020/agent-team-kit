import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  type AutopilotConfig,
  type AutopilotSchedule,
  eventEnvelopeSchema,
  newId,
} from "@kit/core";
import { runEvolutionCycle } from "@kit/evolution";
import {
  findApprovalRequest,
  findDecisionForRequest,
  recordDecision,
} from "@kit/manager";
import {
  type LoadedPack,
  buildPackRun,
  loadPack,
  simulatePack,
} from "@kit/pack";
import { initStore, loadStoreConfig } from "@kit/store";
import { createTemporalClient, taskQueue } from "@kit/workflow";
import { nextCronOccurrence } from "./cron";
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

  try {
    for (const pack of packs) {
      try {
        const state = await ensureState(
          store.autopilotState,
          WORKSPACE_ID,
          pack.dirName,
          pack.config.enabled,
          now,
        );
        if (!state.enabled) {
          state.lastTickAt = now.toISOString();
          await saveState(store.autopilotState, state);
          continue;
        }
        result.enabled += 1;

        await processSchedules({
          pack,
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
          pack,
          state,
          now,
          dryRun: options.dryRun ?? false,
          result,
          getTemporal: async () => {
            temporal ??= await createTemporalClient();
            return temporal;
          },
        });

        await processAutoApprovals({
          pack,
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
          pack,
          state,
          now,
          dryRun: options.dryRun ?? false,
          store,
          result,
        });

        state.lastTickAt = now.toISOString();
        await saveState(store.autopilotState, state);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${pack.dirName}: ${message}`);
      }
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

    const estimate =
      simulation.workflows.find((workflow) => workflow.id === schedule.workflow)
        ?.totalCostCny ?? 0;
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
  result: TickResult;
  getTemporal: () => Promise<Awaited<ReturnType<typeof createTemporalClient>>>;
}): Promise<boolean> {
  const { pack, state, now, result } = input;
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

    const iterationId = newId("it");
    try {
      const { client } = await input.getTemporal();
      await client.workflow.start("iterationWorkflow", {
        taskQueue,
        workflowId: `iteration-${iterationId}`,
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
    const record = await runEvolutionCycle({
      packDir: input.pack.dir,
      agentId: config.agent,
      inputFile: evidenceFile,
      autoApply: config.autoApply,
      budgetCny: config.budgetCny,
      variantsRoot,
      archivePath: path.join(variantsRoot, "archive.jsonl"),
      cyclesPath: path.join(variantsRoot, "cycles.jsonl"),
      statePath: path.join(variantsRoot, "state.json"),
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

function addCadence(now: Date, cadence: "daily" | "weekly"): string {
  const days = cadence === "weekly" ? 7 : 1;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}
