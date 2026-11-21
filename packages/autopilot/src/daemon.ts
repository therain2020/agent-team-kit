import path from "node:path";
import { isAutoApproveOriginEligible, resolveKillSwitch } from "@kit/core";
import { StoreEvolutionRepository, runEvolutionCycle } from "@kit/evolution";
import {
  backfillApprovals,
  decideApprovalRecord,
  findApprovalRequest,
  findDecisionForRequest,
  recordDecision,
} from "@kit/manager";
import { getActiveAutonomyPreset, getOpsGate } from "@kit/ops";
import {
  appendOp,
  initStore,
  loadStoreConfig,
  withStoreLock,
} from "@kit/store";
import {
  type TriggerPlanePack,
  fireTrigger,
  loadTriggerPlane,
  loadTriggerUsage,
  registryFromPlane,
} from "@kit/trigger";
import { createTemporalClient } from "@kit/workflow";
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
  /** Approval ids moved to `expired` during this tick (SLA maintenance). */
  expired?: string[];
}

type PackContext = TriggerPlanePack;

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

  const configuredRoot = process.env.KIT_BLOB_ROOT;
  const blobRoot = configuredRoot
    ? path.isAbsolute(configuredRoot)
      ? configuredRoot
      : path.resolve(repoRoot, configuredRoot)
    : path.join(repoRoot, ".tmp", "blobs");
  const store = await initStore(
    loadStoreConfig({ ...process.env, KIT_BLOB_ROOT: blobRoot }),
  );
  let temporal: Awaited<ReturnType<typeof createTemporalClient>> | undefined;
  const gate = await getOpsGate(store, now, WORKSPACE_ID);
  if (gate.readOnly) {
    result.nightMode = true;
    result.nightModeReason = gate.reason ?? "night mode";
  }
  const preset = await getActiveAutonomyPreset(store, WORKSPACE_ID);

  try {
    // One loading layer: `autopilot.yaml` maps to Trigger/EventRoute here, and
    // an invalid file makes the pack refuse to schedule (96 §5.4).
    const plane = await loadTriggerPlane(repoRoot, {
      transformConfig: (config) => applyAutonomyPreset(config, preset),
    });
    const packs = plane.packs;
    result.packs = packs.length;
    // Invalid packs are reported and excluded from `plane.packs`; valid packs
    // still tick so one bad file cannot silently freeze the whole daemon.
    result.errors.push(...plane.errors);
    const registry = registryFromPlane(plane);

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
        // Approvals maintenance runs before scheduling so backfilled rows and
        // SLA expiries are visible to the same tick's auto-approval pass.
        await maintainApprovals(store, now, result);
        for (const pack of packs) {
          try {
            const state = await ensureState(
              store.autopilotState,
              WORKSPACE_ID,
              pack.dirName,
              pack.config.enabled,
              now,
            );
            // The preset enables the loop at runtime without persisting
            // enabled=true, so rollback needs no state surgery.
            if (!state.enabled && !pack.config.enabled) {
              state.lastTickAt = now.toISOString();
              if (!(await saveState(store.autopilotState, state))) {
                result.errors.push(
                  `${pack.dirName}: state version conflict (disabled tick)`,
                );
              } else {
                await recordTickOp(store, pack.dirName, state, result, now);
              }
              continue;
            }
            result.enabled += 1;

            if (!gate.readOnly) {
              await processSchedules({
                pack,
                state,
                now,
                dryRun: options.dryRun ?? false,
                repoRoot,
                store,
                registry,
                result,
              });

              await processIterations({
                pack,
                state,
                now,
                dryRun: options.dryRun ?? false,
                repoRoot,
                store,
                registry,
                result,
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
            }

            // Counters stay as a read-model projection; TriggerRun is the
            // single budget fact source (96 §5.1).
            try {
              const usage = await packUsage(store, pack, now);
              state.runsToday = usage.runs;
              state.spentToday = usage.costCny;
            } catch (error) {
              result.errors.push(
                `${pack.dirName}: usage projection failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }

            state.lastTickAt = now.toISOString();
            if (!(await saveState(store.autopilotState, state))) {
              result.errors.push(
                `${pack.dirName}: state version conflict (tick)`,
              );
            } else {
              await recordTickOp(store, pack.dirName, state, result, now);
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

/**
 * Record one autopilot tick in the unified op log. The tick timestamp is the
 * idempotency key so a replayed tick with the same `now` cannot double-write.
 */
async function recordTickOp(
  store: Awaited<ReturnType<typeof initStore>>,
  packDir: string,
  state: AutopilotState,
  result: TickResult,
  now: Date,
): Promise<void> {
  try {
    await appendOp(store, {
      workspaceId: WORKSPACE_ID,
      entityKind: "autopilot_state",
      entityId: `${WORKSPACE_ID}:${packDir}`,
      op: "autopilot.tick",
      actor: "autopilot",
      origin: "autopilot",
      idempotencyKey: `autopilot.tick:${WORKSPACE_ID}:${packDir}:${now.toISOString()}`,
      payload: {
        enabled: state.enabled,
        runsToday: state.runsToday,
        spentToday: state.spentToday,
        launched: result.launched.length,
        errors: result.errors.length,
      },
      createdAt: now.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`${packDir}: op log failed: ${message}`);
  }
}

async function processSchedules(input: {
  pack: PackContext;
  state: AutopilotState;
  now: Date;
  dryRun: boolean;
  repoRoot: string;
  store: Awaited<ReturnType<typeof initStore>>;
  registry: ReturnType<typeof registryFromPlane>;
  result: TickResult;
}): Promise<boolean> {
  return processDueTriggers({ ...input, jobKind: "packRun" });
}

async function processIterations(input: {
  pack: PackContext;
  state: AutopilotState;
  now: Date;
  dryRun: boolean;
  repoRoot: string;
  store: Awaited<ReturnType<typeof initStore>>;
  registry: ReturnType<typeof registryFromPlane>;
  result: TickResult;
}): Promise<boolean> {
  return processDueTriggers({ ...input, jobKind: "iteration" });
}

/**
 * One scheduling loop for every cron-backed trigger. Due slots advance here;
 * everything else (gates, budget, startJob, TriggerRun write-back) belongs to
 * `fireTrigger`, so adding a trigger kind never touches this function.
 */
async function processDueTriggers(input: {
  pack: PackContext;
  state: AutopilotState;
  now: Date;
  dryRun: boolean;
  repoRoot: string;
  store: Awaited<ReturnType<typeof initStore>>;
  registry: ReturnType<typeof registryFromPlane>;
  result: TickResult;
  jobKind: "packRun" | "iteration";
}): Promise<boolean> {
  const { pack, state, now, repoRoot, store, result } = input;
  let changed = false;

  for (const route of pack.routes) {
    if (route.jobKind !== input.jobKind) {
      continue;
    }
    const trigger = pack.triggers.find(
      (item) => item.triggerId === route.triggerRef,
    );
    // The console toggle lives in state; either side can enable a pack.
    if (!trigger?.schedule || (!trigger.enabled && !state.enabled)) {
      continue;
    }
    if (input.jobKind === "iteration" && !pack.loaded.iteration) {
      result.errors.push(
        `${pack.dirName}/${trigger.triggerId}: iteration.yaml is missing`,
      );
      continue;
    }
    const nextKey =
      input.jobKind === "iteration"
        ? `__iteration:${trigger.triggerId}`
        : trigger.triggerId;
    const nextValue = state.nextRuns[nextKey];
    if (!nextValue) {
      try {
        state.nextRuns[nextKey] = nextCronOccurrence(
          trigger.schedule.cron,
          now,
          trigger.schedule.timezone,
        ).toISOString();
        changed = true;
      } catch (error) {
        result.errors.push(
          `${pack.dirName}/${trigger.triggerId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
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
      state.nextRuns[nextKey] = nextCronOccurrence(
        trigger.schedule.cron,
        now,
        trigger.schedule.timezone,
      ).toISOString();
    } catch (error) {
      result.errors.push(
        `${pack.dirName}/${trigger.triggerId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    changed = true;

    const workflowLabel =
      route.jobKind === "iteration"
        ? `iteration:${trigger.triggerId}`
        : (route.workflow ?? trigger.triggerId);

    if (input.dryRun) {
      result.launched.push({
        pack: pack.dirName,
        workflow: workflowLabel,
        runId: "dry-run",
      });
      continue;
    }

    const fired = await fireTrigger(
      {
        triggerId: trigger.triggerId,
        dedupeKey: `autopilot:${pack.dirName}:${trigger.triggerId}:${slot}`,
        trigger,
        route,
      },
      {
        store,
        repoRoot,
        workspaceId: WORKSPACE_ID,
        now,
        registry: input.registry,
      },
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      state.lastError = message;
      result.errors.push(`${pack.dirName}/${trigger.triggerId}: ${message}`);
      return null;
    });
    if (!fired) {
      continue;
    }

    if (fired.dispatch === "STARTED" && fired.jobId) {
      result.launched.push({
        pack: pack.dirName,
        workflow: workflowLabel,
        runId: fired.jobId,
      });
      continue;
    }
    if (fired.dispatch === "USE_EXISTING") {
      result.errors.push(
        `${pack.dirName}/${trigger.triggerId}: skipped, already launched for slot ${slot}`,
      );
      continue;
    }
    const message = fired.reason ?? "dispatch failed";
    if (fired.dispatch === "FAILED") {
      state.lastError = message;
    }
    result.errors.push(`${pack.dirName}/${trigger.triggerId}: ${message}`);
  }

  return changed;
}

/**
 * Periodic approvals maintenance, folded into the autopilot tick instead of
 * spawning another daemon: backfill entities for pre-upgrade paused runs, then
 * flip rows past their expiry to `expired` (with activity audit).
 */
async function maintainApprovals(
  store: Awaited<ReturnType<typeof initStore>>,
  now: Date,
  result: TickResult,
): Promise<void> {
  try {
    await backfillApprovals(store, { workspaceId: WORKSPACE_ID });
  } catch (error) {
    result.errors.push(
      `approvals backfill: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const expired = await store.approvals.expireDue(now.toISOString());
    if (expired.length > 0) {
      result.expired = [
        ...(result.expired ?? []),
        ...expired.map((row) => row.approvalId),
      ];
    }
  } catch (error) {
    result.errors.push(
      `approvals expiry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
  const scope = policy.scope ?? "scheduled";
  const paused = await store.runs.list({ status: "paused", limit: 50 });
  for (const run of paused) {
    // Manual, web, cli and pre-upgrade (`unknown`) runs are never approved by
    // policy unless the operator explicitly opts into `scope: all`.
    if (!isAutoApproveOriginEligible(run.originKind, scope)) {
      continue;
    }
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

    const note = `auto-approved by autopilot (risk ${approval.riskClass}, cost ${cost.toFixed(4)} CNY)`;
    const recorded = await decideApprovalRecord(store, {
      runId: run.runId,
      requestId: approval.requestId,
      decision: "approve",
      actor: "policy:autopilot",
      note,
    });
    if (!recorded.ok) {
      result.errors.push(`${run.runId}: ${recorded.error}`);
      continue;
    }
    if (!recorded.duplicate) {
      await recordDecision(store, run.runId, "approve", note, {
        requestId: approval.requestId,
        actor: "policy:autopilot",
      });
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
      `[autopilot] evolution cycle ${record.cycleId} decision=${record.decision} budget=${record.budgetStatus} costCny=${record.costCny} candidatePass=${record.candidatePass}`,
    );
    if (record.budgetStatus === "budget_exceeded") {
      // A budget gate must never look like a silent skip: the cycle record
      // carries `budget_exceeded` and the rationale names the blocking phase.
      console.warn(
        `[autopilot] evolution cycle ${record.cycleId} stopped by budget: ${record.rationale}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.state.lastError = message;
    input.result.errors.push(
      `${input.pack.dirName}: evolution failed: ${message}`,
    );
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

async function packUsage(
  store: Awaited<ReturnType<typeof initStore>>,
  pack: PackContext,
  now: Date,
): Promise<{ runs: number; costCny: number }> {
  let runs = 0;
  let costCny = 0;
  for (const trigger of pack.triggers) {
    const usage = await loadTriggerUsage(
      store,
      WORKSPACE_ID,
      trigger,
      now,
      true,
    );
    runs += usage.runs;
    costCny += usage.costCny;
  }
  return { runs, costCny: Math.round(costCny * 10000) / 10000 };
}

function addCadence(now: Date, cadence: "daily" | "weekly"): string {
  const days = cadence === "weekly" ? 7 : 1;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}
