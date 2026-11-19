import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendActivity, listActivity } from "@kit/activity";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorldDelta, loadWorldSnapshot } from "../lib/world";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function sqliteStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-world-"));
  dirs.push(dir);
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: dir,
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
  closers.push(() => store.close());
  return store;
}

function countingStore(store: Awaited<ReturnType<typeof sqliteStore>>) {
  let calls = 0;
  // Every template tag invocation maps to one statement (or one inlined
  // fragment); comparing counts catches any per-run regression.
  const sql = new Proxy(store.sql, {
    apply(target, thisArg, args) {
      calls += 1;
      return Reflect.apply(
        target as (...inner: unknown[]) => unknown,
        thisArg,
        args,
      );
    },
  }) as typeof store.sql;
  return { store: { sql }, calls: () => calls };
}

async function seedRuns(
  store: Awaited<ReturnType<typeof sqliteStore>>,
  n: number,
) {
  for (let index = 0; index < n; index += 1) {
    await appendActivity(store, {
      runId: `run_${index}`,
      agentId: `agent_${index % 3}`,
      kind: "run.started",
      status: "running",
    });
  }
}

describe("world snapshot and deltas", () => {
  it("snapshots at the activity cursor and resumes without gaps", async () => {
    const store = await sqliteStore();
    await appendActivity(store, {
      runId: "run_1",
      agentId: "writer",
      kind: "stage.started",
      status: "running",
      summary: "collect",
    });
    await appendActivity(store, {
      runId: "run_2",
      agentId: "critic",
      kind: "stage.started",
      status: "running",
      summary: "review",
    });
    const last = await appendActivity(store, {
      runId: "run_1",
      agentId: "writer",
      kind: "tool.call",
      status: "running",
      tool: "repo_read",
      summary: "repo_read",
    });

    const snapshot = await loadWorldSnapshot(store);
    expect(snapshot.seq).toBe(last);
    expect(snapshot.etag).toBe(`W/"world-${last}"`);
    expect(snapshot.snapshot.runs.map((run) => run.runId).sort()).toEqual([
      "run_1",
      "run_2",
    ]);
    expect(
      snapshot.snapshot.agents.find((agent) => agent.agentId === "writer"),
    ).toMatchObject({ state: "running", currentTool: "repo_read" });

    // Something changes after the snapshot: the stream resumes from `seq`.
    await appendActivity(store, {
      runId: "run_1",
      kind: "budget.exceeded",
      status: "paused",
      summary: "budget exhausted",
    });
    const pending = await listActivity(store, { after: snapshot.seq });
    expect(pending).toHaveLength(1);
    const delta = await buildWorldDelta(store, "default", pending);
    expect(delta.seq).toBeGreaterThan(snapshot.seq);
    expect(delta.runs).toHaveLength(1);
    expect(delta.runs[0]).toMatchObject({
      runId: "run_1",
      status: "paused",
      waitReason: "budget exhausted",
    });

    // Repeated batches from the same cursor are idempotent.
    expect(await listActivity(store, { after: delta.seq })).toHaveLength(0);

    // `since` returns only runs materialized after the cursor.
    const incremental = await loadWorldSnapshot(store, {
      since: snapshot.seq,
    });
    expect(incremental.snapshot.runs.map((run) => run.runId)).toEqual([
      "run_1",
    ]);
    expect(incremental.seq).toBe(delta.seq);
  });

  it("keeps the full snapshot when no cursor is given", async () => {
    const store = await sqliteStore();
    await appendActivity(store, {
      runId: "run_1",
      kind: "run.started",
      status: "running",
    });
    const snapshot = await loadWorldSnapshot(store, { limit: 1 });
    expect(snapshot.snapshot.runs).toHaveLength(1);
    expect(snapshot.snapshot.agents).toEqual([]);
  });

  it("snapshot cost stays constant as runs grow", async () => {
    const small = await sqliteStore();
    await seedRuns(small, 4);
    const smallCounter = countingStore(small);
    const smallSnapshot = await loadWorldSnapshot(smallCounter.store);
    expect(smallSnapshot.snapshot.runs).toHaveLength(4);

    const large = await sqliteStore();
    await seedRuns(large, 48);
    const largeCounter = countingStore(large);
    const largeSnapshot = await loadWorldSnapshot(largeCounter.store);
    expect(largeSnapshot.snapshot.runs).toHaveLength(48);

    expect(largeCounter.calls()).toBe(smallCounter.calls());
    expect(largeCounter.calls()).toBeLessThanOrEqual(4);
  });
});
