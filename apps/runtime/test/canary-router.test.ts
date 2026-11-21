import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EventEnvelope } from "@kit/core";
import { type CanaryState, bucketForRun } from "@kit/evolution";
import { initStore, loadStoreConfig } from "@kit/store";
import type { PackRunInput } from "@kit/workflow";
import { afterEach, describe, expect, it } from "vitest";
import {
  EventRouter,
  EvolutionRunVariantSelector,
  type RunVariantSelection,
} from "../src/router";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "kit-canary-router-"));
  roots.push(root);
  const packDir = path.join(root, "packs", "tech-radar");
  const candidateDir = path.join(root, "variants", "candidate");
  await cp(path.join(process.cwd(), "packs", "tech-radar"), packDir, {
    recursive: true,
  });
  await cp(packDir, candidateDir, { recursive: true });
  const writer = path.join(candidateDir, "agents", "writer.md");
  await writeFile(
    writer,
    `${await readFile(writer, "utf8")}\n\nCANARY-MARKER\n`,
    "utf8",
  );
  return { root, candidateDir };
}

async function sqliteStore(root: string) {
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: path.join(root, ".kit"),
      KIT_BLOB_ROOT: path.join(root, "blobs"),
    }),
  );
  closers.push(() => store.close());
  return store;
}

function event(): EventEnvelope {
  return {
    eventId: "evt_canary_test",
    type: "tech.signal.priority",
    schemaVersion: "1.0",
    occurredAt: "2026-11-15T00:00:00.000Z",
    receivedAt: "2026-11-15T00:00:00.000Z",
    workspaceId: "default",
    idempotencyKey: "canary-test",
    traceId: "trace_canary",
    payloadRef: "payload:canary",
  };
}

function routerFor(
  root: string,
  store: Awaited<ReturnType<typeof initStore>>,
  select: (
    workspaceId: string,
    runId: string,
  ) => Promise<RunVariantSelection | null>,
): EventRouter {
  return new EventRouter(store, root, { select }, "default");
}

async function runInput(
  store: Awaited<ReturnType<typeof initStore>>,
  runId: string,
): Promise<PackRunInput> {
  const request = await store.runRequests.find(runId);
  expect(request).not.toBeNull();
  return JSON.parse(request?.payload ?? "{}") as PackRunInput;
}

describe("runtime canary routing", () => {
  it("starts bucketed runs from the candidate variant", async () => {
    const { root, candidateDir } = await setup();
    const store = await sqliteStore(root);
    const router = routerFor(root, store, async () => ({
      path: candidateDir,
      variantId: "var_canary",
      trafficPercent: 20,
    }));

    const result = await router.route(event(), { signal: "test" });

    expect(result.errors).toEqual([]);
    expect(result.started).toHaveLength(1);
    expect(result.started[0]?.variant).toBe("canary");
    const input = await runInput(store, result.started[0]?.runId ?? "");
    expect(input.workspaceId).toBe("default");
    expect(input.variant).toEqual({
      role: "canary",
      variantId: "var_canary",
      trafficPercent: 20,
    });
    expect(
      input.stages.find((stage) => stage.stageName === "summarize")
        ?.instructions,
    ).toContain("CANARY-MARKER");
  });

  it("routes through startJob with an event origin and the triggering eventId", async () => {
    const { root } = await setup();
    const store = await sqliteStore(root);
    const router = routerFor(root, store, async () => null);

    const result = await router.route(event(), { signal: "test" });

    expect(result.errors).toEqual([]);
    const started = result.started[0];
    const input = await runInput(store, started?.runId ?? "");
    expect(input.variant).toBeUndefined();
    expect(input.eventId).toBe("evt_canary_test");
    expect(input.origin).toEqual({
      kind: "event",
      triggerId: "tech-radar:flash-radar",
      // T3: the origin points at the TriggerRun (one per firing), not the event.
      triggerRunId: expect.stringMatching(/^trg_/),
    });
    expect(
      input.stages.find((stage) => stage.stageName === "summarize")
        ?.instructions,
    ).not.toContain("CANARY-MARKER");
  });

  it("dedupes a replayed event to the first run", async () => {
    const { root } = await setup();
    const store = await sqliteStore(root);
    const router = routerFor(root, store, async () => null);

    const first = await router.route(event(), { signal: "test" });
    const second = await router.route(event(), { signal: "test" });

    expect(first.started).toHaveLength(1);
    expect(second.started).toHaveLength(0);
    expect(second.skipped).toContainEqual({
      pack: "tech-radar",
      workflow: "flash-radar",
      reason: "duplicate event",
    });
  });
});

describe("evolution run variant selector", () => {
  function state(candidateDir: string): CanaryState {
    return {
      workspaceId: "ws-a",
      champion: { path: "/champion" },
      canary: {
        path: candidateDir,
        variantId: "var_canary",
        agentId: "writer",
        trafficPercent: 20,
        status: "canary",
        since: "2026-11-15T00:00:00.000Z",
      },
    };
  }

  it("selects candidates only inside the canary workspace", async () => {
    const { candidateDir } = await setup();
    const repo = {
      workspaceId: "ws-a",
      getState: async () => ({ state: state(candidateDir), version: 0 }),
    };
    const selector = new EvolutionRunVariantSelector(
      repo as never,
      15_000,
      () => 0,
    );

    let runId = "";
    for (let index = 0; index < 10_000; index += 1) {
      if (bucketForRun(`run_${index}`) < 20) {
        runId = `run_${index}`;
        break;
      }
    }

    expect(await selector.select("ws-a", runId)).toMatchObject({
      path: candidateDir,
      variantId: "var_canary",
    });
    expect(await selector.select("ws-b", runId)).toBeNull();
  });

  it("falls back to the pack when the variant directory is missing", async () => {
    const repo = {
      workspaceId: "ws-a",
      getState: async () => ({
        state: state(path.join(tmpdir(), "kit-missing-variant")),
        version: 0,
      }),
    };
    const selector = new EvolutionRunVariantSelector(
      repo as never,
      15_000,
      () => 0,
    );

    let runId = "";
    for (let index = 0; index < 10_000; index += 1) {
      if (bucketForRun(`run_${index}`) < 20) {
        runId = `run_${index}`;
        break;
      }
    }

    expect(await selector.select("ws-a", runId)).toBeNull();
  });
});
