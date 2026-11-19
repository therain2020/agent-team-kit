import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import { pruneEventRetention } from "../src/retention";
import { initStore } from "../src/store";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-19T00:00:00.000Z");
const CUTOFF = new Date(NOW.getTime() - 90 * DAY_MS).toISOString();
const OLD = new Date(NOW.getTime() - 91 * DAY_MS).toISOString();
const FRESH = new Date(NOW.getTime() - 89 * DAY_MS).toISOString();

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-retention-"));
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

type Store = Awaited<ReturnType<typeof sqliteStore>>;

async function insertActivity(
  store: Store,
  kind: string,
  at: string,
): Promise<void> {
  await store.sql`
    INSERT INTO activity_events (workspace_id, kind, payload, created_at)
    VALUES (${"default"}, ${kind}, ${store.sql.json({})}, ${at})
  `;
}

async function seedIterationRun(
  store: Store,
  iterationId: string,
  at: string,
): Promise<void> {
  await store.sql`
    INSERT INTO iteration_runs (
      iteration_id, workflow_id, workspace_id, goal, run_mode, apply_mode,
      status, phase, started_at, updated_at
    ) VALUES (
      ${iterationId}, ${"retention"}, ${"default"}, ${"prune old events"},
      ${"DRY_RUN"}, ${"none"}, ${"running"}, ${"planned"}, ${at}, ${at}
    )
  `;
}

async function insertIterationEvent(
  store: Store,
  iterationId: string,
  kind: string,
  at: string,
): Promise<void> {
  await store.sql`
    INSERT INTO iteration_events (
      iteration_id, kind, payload, created_at
    ) VALUES (
      ${iterationId}, ${kind}, ${store.sql.json({})}, ${at}
    )
  `;
}

async function countRows(
  store: Store,
): Promise<{ activity: number; iterations: number }> {
  const [activity] = await store.sql<Array<{ total: number }>>`
    SELECT COUNT(*) AS total FROM activity_events
  `;
  const [iterations] = await store.sql<Array<{ total: number }>>`
    SELECT COUNT(*) AS total FROM iteration_events
  `;
  return {
    activity: Number(activity?.total ?? 0),
    iterations: Number(iterations?.total ?? 0),
  };
}

describe("event retention (sqlite)", () => {
  it("dry-run reports eligible counts and range without deleting", async () => {
    const store = await sqliteStore();
    await insertActivity(store, "old.a", OLD);
    await insertActivity(store, "old.b", OLD);
    await insertActivity(store, "fresh", FRESH);
    await seedIterationRun(store, "it_retention", OLD);
    await insertIterationEvent(store, "it_retention", "run.started", OLD);
    await insertIterationEvent(store, "it_retention", "task.planned", FRESH);

    const report = await pruneEventRetention(store, {
      now: NOW,
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.retentionDays).toBe(90);
    expect(report.cutoff).toBe(CUTOFF);
    expect(report.eligible).toBe(3);
    expect(report.deleted).toBe(0);
    const activity = report.tables.find(
      (table) => table.table === "activity_events",
    );
    expect(activity).toMatchObject({
      eligible: 2,
      deleted: 0,
      oldest: OLD,
      newest: OLD,
    });
    const iterations = report.tables.find(
      (table) => table.table === "iteration_events",
    );
    expect(iterations).toMatchObject({
      eligible: 1,
      deleted: 0,
      oldest: OLD,
      newest: OLD,
    });
    // Nothing was deleted in dry-run.
    expect(await countRows(store)).toEqual({ activity: 3, iterations: 2 });
  });

  it("prunes only old rows, then is idempotent", async () => {
    const store = await sqliteStore();
    await insertActivity(store, "old", OLD);
    await insertActivity(store, "boundary", CUTOFF);
    await insertActivity(store, "fresh", FRESH);
    await seedIterationRun(store, "it_retention", OLD);
    await insertIterationEvent(store, "it_retention", "old", OLD);
    await insertIterationEvent(store, "it_retention", "boundary", CUTOFF);
    await insertIterationEvent(store, "it_retention", "fresh", FRESH);

    const first = await pruneEventRetention(store, { now: NOW });
    expect(first.deleted).toBe(2);
    expect(first.eligible).toBe(2);
    expect(await countRows(store)).toEqual({ activity: 2, iterations: 2 });

    // The row exactly at the cutoff survives: the comparison is strict.
    const [boundary] = await store.sql<Array<{ total: number }>>`
      SELECT COUNT(*) AS total FROM activity_events
      WHERE kind = ${"boundary"}
    `;
    expect(Number(boundary?.total)).toBe(1);

    const second = await pruneEventRetention(store, { now: NOW });
    expect(second.deleted).toBe(0);
    expect(second.eligible).toBe(0);
    expect(await countRows(store)).toEqual({ activity: 2, iterations: 2 });
  });

  it("honors batch size and the per-call row cap", async () => {
    const store = await sqliteStore();
    for (let index = 0; index < 4; index += 1) {
      await insertActivity(store, `old.${index}`, OLD);
    }

    const capped = await pruneEventRetention(store, {
      now: NOW,
      batchSize: 1,
      maxRowsPerCall: 2,
    });
    expect(capped.eligible).toBe(4);
    expect(capped.deleted).toBe(2);
    expect((await countRows(store)).activity).toBe(2);

    const rest = await pruneEventRetention(store, {
      now: NOW,
      batchSize: 1,
      maxRowsPerCall: 2,
    });
    expect(rest.deleted).toBe(2);
    expect((await countRows(store)).activity).toBe(0);
  });

  it("leaves runs, stages and the projection table untouched", async () => {
    const store = await sqliteStore();
    await store.sql`
      INSERT INTO runs (
        run_id, event_id, workspace_id, workflow_id, workflow_version,
        run_mode, status, created_at, updated_at
      ) VALUES (
        ${"run_retention"}, ${"evt_retention"}, ${"default"}, ${"workflow"},
        ${"1.0.0"}, ${"DRY_RUN"}, ${"completed"}, ${OLD}, ${OLD}
      )
    `;
    await insertActivity(store, "old", OLD);

    await pruneEventRetention(store, { now: NOW });

    const [runs] = await store.sql<Array<{ total: number }>>`
      SELECT COUNT(*) AS total FROM runs WHERE run_id = ${"run_retention"}
    `;
    expect(Number(runs?.total)).toBe(1);
    expect((await countRows(store)).activity).toBe(0);
  });

  it("rejects non-positive retention options", async () => {
    const store = await sqliteStore();
    await expect(
      pruneEventRetention(store, { retentionDays: 0, now: NOW }),
    ).rejects.toThrow(RangeError);
    await expect(
      pruneEventRetention(store, { batchSize: 0, now: NOW }),
    ).rejects.toThrow(RangeError);
    await expect(
      pruneEventRetention(store, { maxRowsPerCall: 1.5, now: NOW }),
    ).rejects.toThrow(RangeError);
    await expect(
      pruneEventRetention(store, { now: "not-a-date" }),
    ).rejects.toThrow(RangeError);
  });
});
