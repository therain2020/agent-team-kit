import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StartJobInput } from "@kit/job";
import { type AdmitRunInput, initStore, loadStoreConfig } from "@kit/store";
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
  const root = await mkdtemp(path.join(tmpdir(), "kit-evolution-dispatch-"));
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

function evolutionTrigger(): Trigger {
  return triggerSchema.parse({
    triggerId: "tech-radar:evolution",
    kind: "schedule",
    source: "autopilot.yaml",
    schedule: { cron: "0 0 * * 1", timezone: "UTC" },
    routeRef: "tech-radar:evolution:cycle",
  });
}

function evolutionRoute(overrides: Partial<EventRoute> = {}): EventRoute {
  return eventRouteSchema.parse({
    routeId: "tech-radar:evolution:cycle",
    triggerRef: "tech-radar:evolution",
    packDir: "tech-radar",
    jobKind: "evolution",
    runMode: "DRY_RUN",
    evolution: {
      cadence: "weekly",
      agent: "writer",
      evidenceFile: "evidence.json",
      autoApply: false,
      budgetCny: 2,
    },
    ...overrides,
  });
}

describe("evolution dispatch", () => {
  it("walks the unified gate sequence and starts an evolution job", async () => {
    const { root, store } = await setup();
    const trail: DispatchGate[] = [];
    const admitted: AdmitRunInput[] = [];
    const started: StartJobInput[] = [];
    let sequence = 0;

    const deps: FireTriggerDeps = {
      store,
      repoRoot: root,
      now: new Date("2026-11-21T12:00:00.000Z"),
      killSwitchFn: (() => null) as unknown as FireTriggerDeps["killSwitchFn"],
      opsGateFn: (async () => ({
        readOnly: false,
        nightMode: false,
        nightException: false,
        reason: null,
        timezone: "UTC",
        action: null,
      })) as unknown as FireTriggerDeps["opsGateFn"],
      admitRunFn: async (input) => {
        admitted.push(input);
        return {
          ok: true,
          budgets: [],
          errors: [],
          estimateCnyMicro: 0,
          estimateTokens: 0,
          blocking: null,
          reason: null,
        } as unknown as Awaited<
          ReturnType<NonNullable<FireTriggerDeps["admitRunFn"]>>
        >;
      },
      startJobFn: (async (
        _store: unknown,
        input: StartJobInput,
      ): Promise<unknown> => {
        started.push(input);
        sequence += 1;
        return {
          jobId: `cyc_${sequence}`,
          kind: "evolution",
          workflowId: `evolution-cyc_${sequence}`,
          engine: "local",
          runMode: "DRY_RUN",
          pack: "tech-radar",
        };
      }) as unknown as FireTriggerDeps["startJobFn"],
      onGate: (gate) => trail.push(gate),
    };

    const result = await fireTrigger(
      {
        triggerId: "tech-radar:evolution",
        dedupeKey: "autopilot:tech-radar:evolution:2026-11-21",
        trigger: evolutionTrigger(),
        route: evolutionRoute(),
      },
      deps,
    );

    expect(result.dispatch).toBe("STARTED");
    expect(result.triggerRunId).toBeTruthy();
    expect(trail).toEqual([...DISPATCH_GATES]);
    // The shared budget ledger is admitted before the job starts.
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.runId).toMatch(/^evo_/);
    // startJob receives the evolution kind and pack-relative evidence.
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      kind: "evolution",
      packDir: "tech-radar",
      evolution: {
        agentId: "writer",
        autoApply: false,
        budgetCny: 2,
      },
      origin: {
        kind: "schedule",
        triggerId: "tech-radar:evolution",
      },
    });
    expect(started[0]?.evolution?.evidenceFile).toBe(
      path.join(root, "packs", "tech-radar", "evidence.json"),
    );

    const rows = await store.triggerRuns.list("default", {
      triggerId: "tech-radar:evolution",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobKind).toBe("evolution");
    expect(rows[0]?.jobId).toBe(result.jobId);
    expect(rows[0]?.kind).toBe("schedule");
  }, 60_000);
});
