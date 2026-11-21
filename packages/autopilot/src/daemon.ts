import path from "node:path";
import { resolveKillSwitch } from "@kit/core";
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
import { runApprovalTick } from "./approvals";
import { nextCronOccurrence } from "./cron";
import { applyAutonomyPreset } from "./preset";
import { type AutopilotState, ensureState, saveState } from "./state";

const WORKSPACE_ID = "default";
const TICK_MS = 30_000;

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
        const activePacks: TriggerPlanePack[] = [];
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
            activePacks.push(pack);

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

              await processEvolutionTriggers({
                pack,
                state,
                now,
                dryRun: options.dryRun ?? false,
                repoRoot,
                store,
                registry,
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

        // Approval maintenance is global; the policy pass only sees packs the
        // loop actually enabled. Both live in `@kit/manager` (96 §5.2).
        try {
          const approvals = await runApprovalTick({
            store,
            now,
            packs: activePacks,
            readOnly: gate.readOnly,
          });
          result.expired = [...(result.expired ?? []), ...approvals.expired];
          result.autoApproved.push(...approvals.approved);
          result.aborted.push(...approvals.aborted);
          result.errors.push(...approvals.errors);
        } catch (error) {
          result.errors.push(
            `approvals: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        return true;
      },
    );
    if (acquired === null) {
      result.errors.push("autopilot tick skipped: another tick holds the lock");
    }
  } finally {
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
 * Evolution used to execute inside the tick. It is now one more cron-backed
 * trigger: due slots advance here, and `fireTrigger` runs the gate sequence
 * before handing the job to `startJob` (96 §5.3).
 */
async function processEvolutionTriggers(input: {
  pack: PackContext;
  state: AutopilotState;
  now: Date;
  dryRun: boolean;
  repoRoot: string;
  store: Awaited<ReturnType<typeof initStore>>;
  registry: ReturnType<typeof registryFromPlane>;
  result: TickResult;
}): Promise<boolean> {
  return processDueTriggers({ ...input, jobKind: "evolution" });
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
  jobKind: "packRun" | "iteration" | "evolution";
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
    if (input.jobKind === "evolution") {
      // Evolution stays opt-in even when the console enables the pack; the
      // config flag is the authority (previous `processEvolution` contract).
      if (!pack.config.evolution?.enabled) {
        continue;
      }
      if (!pack.config.evolution.evidenceFile) {
        result.errors.push(
          `${pack.dirName}/${trigger.triggerId}: evolution enabled but evidenceFile is missing`,
        );
        continue;
      }
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
        : route.jobKind === "evolution"
          ? `evolution:${trigger.triggerId}`
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
