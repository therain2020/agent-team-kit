import { nextCronOccurrence } from "@kit/autopilot";
import {
  type EventRoute,
  type Trigger,
  type TriggerBudget,
  loadTriggerPlane,
  loadTriggerUsage,
  resolveTriggerBudget,
} from "@kit/trigger";
import { getRepoRoot } from "./paths";
import { ensureStoreSchema, getStore } from "./store";

/**
 * Server read path for the `/triggers` control surface (96 §5.5, T5).
 *
 * Triggers come from the trigger plane (`autopilot.yaml` mapped once at load
 * time); budgets and "today" usage come from the TriggerRun ledger plus the
 * runs/iteration tables, never from the daemon's counters (96 §5.1, D-68).
 * The daemon state only contributes heartbeat and the pack switch.
 */

const WORKSPACE_ID = "default";
const ONLINE_WINDOW_MS = 120_000;

export interface TriggerScheduleView {
  cron: string;
  timezone: string;
  nextRun: string | null;
}

export interface TriggerUsageView {
  runs: number;
  costCny: number;
  /** Cost is only summed when a daily cost cap makes it actionable. */
  costTracked: boolean;
}

export interface TriggerView {
  triggerId: string;
  kind: Trigger["kind"];
  source: string;
  packDir: string;
  packName: string;
  /** Effective for the daemon: declared in config or enabled by the pack switch. */
  enabled: boolean;
  declaredEnabled: boolean;
  routeId: string;
  jobKind: EventRoute["jobKind"];
  /** Workflow id for pack runs, goal for iterations, "evolution" otherwise. */
  target: string;
  runMode: string;
  schedule: TriggerScheduleView | null;
  budget: TriggerBudget | null;
  usage: TriggerUsageView;
}

export interface TriggerPackView {
  dirName: string;
  name: string;
  /** The durable `autopilotState.enabled` switch for this pack. */
  enabled: boolean;
  lastTickAt: string | null;
  lastError: string | null;
  triggers: TriggerView[];
}

export interface TriggerConsoleData {
  heartbeat: string | null;
  online: boolean;
  packs: TriggerPackView[];
  errors: string[];
  loadedAt: string;
}

export async function loadTriggerConsole(): Promise<TriggerConsoleData> {
  await ensureStoreSchema();
  const store = getStore();
  const repoRoot = getRepoRoot();
  const now = new Date();
  const [plane, states] = await Promise.all([
    loadTriggerPlane(repoRoot),
    store.autopilotState.list(WORKSPACE_ID),
  ]);

  const stateByPack = new Map(states.map((state) => [state.packDir, state]));
  const errors = [...plane.errors];
  const packs: TriggerPackView[] = [];

  for (const pack of plane.packs) {
    const state = stateByPack.get(pack.dirName);
    const packEnabled = state?.enabled ?? false;
    const triggers: TriggerView[] = [];

    for (const trigger of pack.triggers) {
      const route = pack.routes.find(
        (item) => item.routeId === trigger.routeRef,
      );
      if (!route) {
        errors.push(
          `${pack.dirName}: trigger ${trigger.triggerId} has no route`,
        );
        continue;
      }
      const budget =
        resolveTriggerBudget(route, trigger.kind, process.env) ?? null;
      const usage = await loadTriggerUsage(
        store,
        WORKSPACE_ID,
        trigger,
        now,
        budget?.dailyCostCny !== undefined,
      );
      triggers.push({
        triggerId: trigger.triggerId,
        kind: trigger.kind,
        source: trigger.source,
        packDir: pack.dirName,
        packName: pack.loaded.pack.metadata.name,
        enabled: packEnabled || trigger.enabled,
        declaredEnabled: trigger.enabled,
        routeId: route.routeId,
        jobKind: route.jobKind,
        target: routeTarget(route),
        runMode: route.runMode,
        schedule: trigger.schedule
          ? {
              cron: trigger.schedule.cron,
              timezone: trigger.schedule.timezone,
              nextRun: resolveNextRun(
                trigger,
                route,
                state?.nextRuns ?? {},
                now,
              ),
            }
          : null,
        budget,
        usage: {
          runs: usage.runs,
          costCny: usage.costCny,
          costTracked: budget?.dailyCostCny !== undefined,
        },
      });
    }

    triggers.sort((a, b) => a.triggerId.localeCompare(b.triggerId));
    packs.push({
      dirName: pack.dirName,
      name: pack.loaded.pack.metadata.name,
      enabled: packEnabled,
      lastTickAt: state?.lastTickAt ?? null,
      lastError: state?.lastError ?? null,
      triggers,
    });
  }

  packs.sort((a, b) => a.name.localeCompare(b.name));

  const heartbeat =
    states
      .map((state) => state.lastTickAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  const online = Boolean(
    heartbeat && Date.now() - new Date(heartbeat).getTime() < ONLINE_WINDOW_MS,
  );

  return {
    heartbeat,
    online,
    packs,
    errors,
    loadedAt: now.toISOString(),
  };
}

function routeTarget(route: EventRoute): string {
  if (route.jobKind === "packRun") {
    return route.workflow ?? route.routeId;
  }
  if (route.jobKind === "iteration") {
    return route.goal ?? route.routeId;
  }
  return route.evolution?.agent ?? "evolution";
}

/**
 * The daemon stores the next slot per trigger in `state.nextRuns`; iteration
 * slots live under a prefixed key because route ids can collide with pack runs.
 * Before the daemon has ever ticked, derive the next occurrence for display.
 */
function resolveNextRun(
  trigger: Trigger,
  route: EventRoute,
  nextRuns: Record<string, string>,
  now: Date,
): string | null {
  if (!trigger.schedule) {
    return null;
  }
  const key =
    route.jobKind === "iteration"
      ? `__iteration:${trigger.triggerId}`
      : trigger.triggerId;
  const stored = nextRuns[key];
  // A stale slot (daemon offline, clock moved) is not a "next" fire; recompute.
  if (stored && new Date(stored).getTime() > now.getTime()) {
    return stored;
  }
  try {
    return nextCronOccurrence(
      trigger.schedule.cron,
      now,
      trigger.schedule.timezone || "UTC",
    ).toISOString();
  } catch {
    return null;
  }
}
