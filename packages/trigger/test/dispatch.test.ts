import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KillSwitch, resolveKillSwitch } from "@kit/core";
import type { getOpsGate } from "@kit/ops";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import { type FireTriggerDeps, fireTrigger } from "../src/dispatch";
import {
  DISPATCH_GATES,
  type DispatchGate,
  type EventRoute,
  type Trigger,
  eventRouteSchema,
  triggerSchema,
} from "../src/types";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "kit-trigger-"));
  roots.push(root);
  const packDir = path.join(root, "packs", "tech-radar");
  await cp(path.join(process.cwd(), "packs", "tech-radar"), packDir, {
    recursive: true,
  });
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: path.join(root, ".kit"),
      KIT_BLOB_ROOT: path.join(root, "blobs"),
    }),
  );
  closers.push(() => store.close());
  return { root, store };
}

function trigger(kind: Trigger["kind"], id = "daily-radar"): Trigger {
  return triggerSchema.parse({
    triggerId: id,
    kind,
    source: "test",
    routeRef: `${id}:route`,
    ...(kind === "schedule"
      ? { schedule: { cron: "0 0 * * *", timezone: "UTC" } }
      : {}),
  });
}

function route(
  triggerId: string,
  overrides: Partial<EventRoute> = {},
): EventRoute {
  return eventRouteSchema.parse({
    routeId: `${triggerId}:route`,
    triggerRef: triggerId,
    packDir: "tech-radar",
    jobKind: "packRun",
    workflow: "daily-radar",
    runMode: "DRY_RUN",
    ...overrides,
  });
}

function deps(
  store: Awaited<ReturnType<typeof initStore>>,
  root: string,
  trail: DispatchGate[],
  overrides: Partial<FireTriggerDeps> = {},
): FireTriggerDeps {
  let counter = 0;
  const startJobFn = (async (_store: unknown, input: { kind: string }) => {
    counter += 1;
    return {
      jobId: `job-${counter}`,
      kind: input.kind,
      workflowId: `pack-job-${counter}`,
      engine: "local",
      runMode: "DRY_RUN",
      pack: "tech-radar",
    };
  }) as unknown as FireTriggerDeps["startJobFn"];
  const opsGateFn = (async () => ({
    readOnly: false,
    nightMode: false,
    nightException: false,
    reason: null,
    timezone: "UTC",
    action: null,
  })) as unknown as typeof getOpsGate;
  return {
    store,
    repoRoot: root,
    now: new Date("2026-11-20T12:00:00.000Z"),
    killSwitchFn: (() => null) as typeof resolveKillSwitch,
    opsGateFn,
    startJobFn,
    onGate: (gate) => trail.push(gate),
    ...overrides,
  };
}

describe("fireTrigger gate contract", () => {
  it("walks the same fixed gate sequence for schedule, event and manual", async () => {
    const { root, store } = await setup();
    const kinds: Trigger["kind"][] = ["schedule", "event", "manual"];
    const trails: DispatchGate[][] = [];

    for (const kind of kinds) {
      const trail: DispatchGate[] = [];
      const id = `${kind}-trigger`;
      const result = await fireTrigger(
        {
          triggerId: id,
          dedupeKey: `${kind}:slot-1`,
          trigger: trigger(kind, id),
          route: route(id),
        },
        deps(store, root, trail),
      );
      expect(result.dispatch).toBe("STARTED");
      expect(result.jobId).not.toBeNull();
      trails.push(trail);
    }

    expect(trails[0]).toEqual([...DISPATCH_GATES]);
    expect(trails[1]).toEqual(trails[0]);
    expect(trails[2]).toEqual(trails[0]);
  }, 60_000);

  it("lets a new adapter use the pipeline without touching dispatch code", async () => {
    const { root, store } = await setup();
    const trail: DispatchGate[] = [];
    const fireNewSource = (dedupeKey: string) =>
      fireTrigger(
        {
          triggerId: "information-trigger",
          dedupeKey,
          payloadRef: "payload:information",
          trigger: trigger("information", "information-trigger"),
          route: route("information-trigger", { runMode: "DRY_RUN" }),
        },
        deps(store, root, trail),
      );

    const first = await fireNewSource("information:evt-1");
    const second = await fireNewSource("information:evt-2");

    expect(first.dispatch).toBe("STARTED");
    expect(second.dispatch).toBe("STARTED");
    expect(trail).toEqual([...DISPATCH_GATES, ...DISPATCH_GATES]);
  }, 60_000);

  it("returns USE_EXISTING for a replayed trigger slot without starting twice", async () => {
    const { root, store } = await setup();
    const trail: DispatchGate[] = [];
    const startJobFn = (async () => {
      throw new Error("startJob must not run for a duplicate slot");
    }) as unknown as FireTriggerDeps["startJobFn"];
    const first = await fireTrigger(
      {
        triggerId: "daily-radar",
        dedupeKey: "schedule:2026-11-20",
        trigger: trigger("schedule"),
        route: route("daily-radar"),
      },
      deps(store, root, trail),
    );
    expect(first.dispatch).toBe("STARTED");

    const replayTrail: DispatchGate[] = [];
    const replay = await fireTrigger(
      {
        triggerId: "daily-radar",
        dedupeKey: "schedule:2026-11-20",
        trigger: trigger("schedule"),
        route: route("daily-radar"),
      },
      deps(store, root, replayTrail, { startJobFn }),
    );

    expect(replay.dispatch).toBe("USE_EXISTING");
    expect(replay.jobId).toBe(first.jobId);
    expect(replay.triggerRunId).toBe(first.triggerRunId);
    expect(replayTrail).toEqual(["kill-switch", "degraded", "dedupe"]);
  }, 60_000);

  it("shares the same gates in local and Scale modes", async () => {
    const { root, store } = await setup();
    const scaleStore = new Proxy(store, {
      get(target, prop) {
        if (prop === "driver") {
          return "postgres";
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof store;

    const outcomes: string[] = [];
    const trails: DispatchGate[][] = [];
    for (const [index, candidate] of [store, scaleStore].entries()) {
      const trail: DispatchGate[] = [];
      const result = await fireTrigger(
        {
          triggerId: "parity-trigger",
          dedupeKey: `parity:${index}`,
          trigger: trigger("manual", "parity-trigger"),
          route: route("parity-trigger"),
        },
        deps(candidate, root, trail),
      );
      outcomes.push(result.dispatch);
      trails.push(trail);
    }

    expect(outcomes).toEqual(["STARTED", "STARTED"]);
    expect(trails[1]).toEqual(trails[0]);
  }, 60_000);

  it("stops at the kill switch before any other gate", async () => {
    const { root, store } = await setup();
    const trail: DispatchGate[] = [];
    const killSwitch = {
      switchId: "ks",
      scope: "global",
      target: "",
      workspaceId: null,
      state: "active",
      activatedBy: "operator:test",
      reason: "drill",
      activatedAt: "2026-11-20T00:00:00.000Z",
      releasedBy: null,
      releasedAt: null,
      releaseReason: null,
      version: 1,
      updatedAt: "2026-11-20T00:00:00.000Z",
    } satisfies KillSwitch;
    let started = 0;
    const result = await fireTrigger(
      {
        triggerId: "daily-radar",
        dedupeKey: "kill-switch",
        trigger: trigger("schedule"),
        route: route("daily-radar"),
      },
      deps(store, root, trail, {
        killSwitchFn: (() => killSwitch) as typeof resolveKillSwitch,
        startJobFn: (async () => {
          started += 1;
          throw new Error("unreachable");
        }) as unknown as FireTriggerDeps["startJobFn"],
      }),
    );

    expect(result.dispatch).toBe("SKIPPED");
    expect(result.gate).toBe("kill-switch");
    expect(started).toBe(0);
    expect(trail).toEqual(["kill-switch"]);
  }, 60_000);

  it("stops at the degraded gate before dedupe or budget", async () => {
    const { root, store } = await setup();
    const trail: DispatchGate[] = [];
    const readOnly = (async () => ({
      readOnly: true,
      nightMode: true,
      nightException: false,
      reason: "night mode 22-07 UTC",
      timezone: "UTC",
      action: "pause_generation" as const,
    })) as unknown as typeof getOpsGate;
    const result = await fireTrigger(
      {
        triggerId: "daily-radar",
        dedupeKey: "degraded",
        trigger: trigger("schedule"),
        route: route("daily-radar"),
      },
      deps(store, root, trail, { opsGateFn: readOnly }),
    );

    expect(result.dispatch).toBe("SKIPPED");
    expect(result.gate).toBe("degraded");
    expect(trail).toEqual(["kill-switch", "degraded"]);
  }, 60_000);

  it("enforces the UTC-day trigger budget from TriggerRuns", async () => {
    const { root, store } = await setup();
    const budgetRoute = route("budget-trigger", {
      budget: { dailyRuns: 1 },
    });
    const firstTrail: DispatchGate[] = [];
    const first = await fireTrigger(
      {
        triggerId: "budget-trigger",
        dedupeKey: "budget:1",
        trigger: trigger("schedule", "budget-trigger"),
        route: budgetRoute,
      },
      deps(store, root, firstTrail),
    );
    expect(first.dispatch).toBe("STARTED");

    const secondTrail: DispatchGate[] = [];
    const second = await fireTrigger(
      {
        triggerId: "budget-trigger",
        dedupeKey: "budget:2",
        trigger: trigger("schedule", "budget-trigger"),
        route: budgetRoute,
      },
      deps(store, root, secondTrail),
    );

    expect(second.dispatch).toBe("SKIPPED");
    expect(second.gate).toBe("trigger-budget");
    expect(secondTrail).toEqual([
      "kill-switch",
      "degraded",
      "dedupe",
      "trigger-budget",
    ]);
  }, 60_000);

  it("writes a TriggerRun that matches the started job", async () => {
    const { root, store } = await setup();
    const trail: DispatchGate[] = [];
    const result = await fireTrigger(
      {
        triggerId: "run-record",
        dedupeKey: "record:1",
        trigger: trigger("manual", "run-record"),
        route: route("run-record"),
      },
      deps(store, root, trail),
    );

    const rows = await store.triggerRuns.list("default", {
      triggerId: "run-record",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.triggerRunId).toBe(result.triggerRunId);
    expect(rows[0]?.jobId).toBe(result.jobId);
    expect(rows[0]?.status).toBe("started");
    expect(rows[0]?.dedupeKey).toBe("record:1");
    expect(rows[0]?.kind).toBe("manual");
    expect(rows[0]?.jobKind).toBe("packRun");
  }, 60_000);
});
