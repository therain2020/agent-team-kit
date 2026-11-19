import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import { costTimeseries } from "../src/cost-service";
import { initStore } from "../src/store";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-cost-series-"));
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

interface ChargeInput {
  id: string;
  runId: string;
  stageId?: string | null;
  agentId?: string | null;
  cnyMicro: number;
  tokens: number;
  at: string;
}

async function insertCharge(
  store: Awaited<ReturnType<typeof sqliteStore>>,
  input: ChargeInput,
): Promise<void> {
  await store.sql`
    INSERT INTO budget_charges (
      charge_id, reservation_id, workspace_id, run_id, stage_id, agent_id,
      purpose, cost_cny_micro, tokens, created_at
    ) VALUES (
      ${input.id}, ${`rsv_${input.id}`}, ${"default"}, ${input.runId},
      ${input.stageId ?? null}, ${input.agentId ?? null}, ${"model"},
      ${input.cnyMicro}, ${input.tokens}, ${input.at}
    )
  `;
}

describe("cost timeseries read model (sqlite)", () => {
  it("buckets charges by minute, run, stage and agent", async () => {
    const store = await sqliteStore();
    await insertCharge(store, {
      id: "c1",
      runId: "run_1",
      stageId: "run_1:stage-a",
      agentId: "writer",
      cnyMicro: 100,
      tokens: 10,
      at: "2026-11-15T12:00:10.000Z",
    });
    await insertCharge(store, {
      id: "c2",
      runId: "run_1",
      stageId: "run_1:stage-a",
      agentId: "writer",
      cnyMicro: 200,
      tokens: 20,
      at: "2026-11-15T12:00:50.750Z",
    });
    await insertCharge(store, {
      id: "c3",
      runId: "run_1",
      stageId: "run_1:stage-a",
      agentId: "critic",
      cnyMicro: 300,
      tokens: 30,
      at: "2026-11-15T12:01:05.000Z",
    });
    await insertCharge(store, {
      id: "c4",
      runId: "run_1",
      stageId: "run_1:stage-b",
      cnyMicro: 400,
      tokens: 40,
      at: "2026-11-15T12:01:59.999Z",
    });

    const rows = await costTimeseries(store, { workspaceId: "default" });
    expect(rows).toEqual([
      {
        bucket: "2026-11-15T12:00:00Z",
        runId: "run_1",
        stageId: "run_1:stage-a",
        agentId: "writer",
        cnyMicro: 300,
        tokens: 30,
      },
      {
        bucket: "2026-11-15T12:01:00Z",
        runId: "run_1",
        stageId: "run_1:stage-a",
        agentId: "critic",
        cnyMicro: 300,
        tokens: 30,
      },
      {
        bucket: "2026-11-15T12:01:00Z",
        runId: "run_1",
        stageId: "run_1:stage-b",
        agentId: null,
        cnyMicro: 400,
        tokens: 40,
      },
    ]);
  });

  it("aligns wider buckets to the epoch", async () => {
    const store = await sqliteStore();
    await insertCharge(store, {
      id: "c1",
      runId: "run_1",
      cnyMicro: 1,
      tokens: 1,
      at: "2026-11-15T12:04:59.999Z",
    });
    await insertCharge(store, {
      id: "c2",
      runId: "run_1",
      cnyMicro: 2,
      tokens: 2,
      at: "2026-11-15T12:05:00.000Z",
    });
    await insertCharge(store, {
      id: "c3",
      runId: "run_1",
      cnyMicro: 4,
      tokens: 4,
      at: "2026-11-15T12:09:30.000Z",
    });

    const rows = await costTimeseries(store, {
      workspaceId: "default",
      bucketMinutes: 5,
    });
    expect(rows.map((row) => [row.bucket, row.cnyMicro, row.tokens])).toEqual([
      ["2026-11-15T12:00:00Z", 1, 1],
      ["2026-11-15T12:05:00Z", 6, 6],
    ]);
  });

  it("reconciles exactly with the budget_charges sum", async () => {
    const store = await sqliteStore();
    const charges: ChargeInput[] = Array.from({ length: 20 }, (_, index) => ({
      id: `c${index}`,
      runId: `run_${index % 3}`,
      stageId: `run_${index % 3}:stage-${index % 2}`,
      agentId: index % 4 === 0 ? null : `agent_${index % 4}`,
      cnyMicro: (index + 1) * 137,
      tokens: (index + 1) * 11,
      at: `2026-11-15T12:${String(index % 10).padStart(2, "0")}:${String(index).padStart(2, "0")}.000Z`,
    }));
    for (const charge of charges) {
      await insertCharge(store, charge);
    }

    const rows = await costTimeseries(store, {
      workspaceId: "default",
      bucketMinutes: 5,
    });
    const summed = rows.reduce(
      (acc, row) => ({
        cnyMicro: acc.cnyMicro + row.cnyMicro,
        tokens: acc.tokens + row.tokens,
      }),
      { cnyMicro: 0, tokens: 0 },
    );
    const expected = charges.reduce(
      (acc, charge) => ({
        cnyMicro: acc.cnyMicro + charge.cnyMicro,
        tokens: acc.tokens + charge.tokens,
      }),
      { cnyMicro: 0, tokens: 0 },
    );
    expect(summed).toEqual(expected);

    const [direct] = await store.sql<
      Array<{ cny_micro: number; tokens: number }>
    >`
      SELECT SUM(cost_cny_micro) AS cny_micro, SUM(tokens) AS tokens
      FROM budget_charges
      WHERE workspace_id = ${"default"}
    `;
    expect(summed.cnyMicro).toBe(Number(direct?.cny_micro));
    expect(summed.tokens).toBe(Number(direct?.tokens));
  });

  it("returns [] when the range has no charges", async () => {
    const store = await sqliteStore();
    await insertCharge(store, {
      id: "c1",
      runId: "run_1",
      cnyMicro: 100,
      tokens: 10,
      at: "2026-11-15T12:00:00.000Z",
    });

    expect(
      await costTimeseries(store, {
        workspaceId: "default",
        since: "2030-01-01T00:00:00.000Z",
      }),
    ).toEqual([]);
    expect(
      await costTimeseries(store, {
        workspaceId: "default",
        since: "2026-11-15T12:00:00.000Z",
        until: "2026-11-15T12:00:00.000Z",
      }),
    ).toEqual([]);
    expect(
      await costTimeseries(store, { workspaceId: "other-workspace" }),
    ).toEqual([]);
  });

  it("filters by run and treats the range as half-open", async () => {
    const store = await sqliteStore();
    await insertCharge(store, {
      id: "c1",
      runId: "run_1",
      cnyMicro: 1,
      tokens: 1,
      at: "2026-11-15T12:00:00.000Z",
    });
    await insertCharge(store, {
      id: "c2",
      runId: "run_1",
      cnyMicro: 2,
      tokens: 2,
      at: "2026-11-15T12:00:59.999Z",
    });
    await insertCharge(store, {
      id: "c3",
      runId: "run_2",
      cnyMicro: 4,
      tokens: 4,
      at: "2026-11-15T12:01:00.000Z",
    });

    const scoped = await costTimeseries(store, {
      workspaceId: "default",
      runId: "run_1",
    });
    expect(scoped.map((row) => [row.bucket, row.runId, row.cnyMicro])).toEqual([
      ["2026-11-15T12:00:00Z", "run_1", 3],
    ]);

    const bounded = await costTimeseries(store, {
      workspaceId: "default",
      since: "2026-11-15T12:00:00.000Z",
      until: "2026-11-15T12:01:00.000Z",
    });
    // c1 and c2 share the 12:00 minute bucket; the charge at exactly `until`
    // is excluded by the half-open upper bound.
    expect(bounded.map((row) => [row.runId, row.cnyMicro])).toEqual([
      ["run_1", 3],
    ]);
  });

  it("rejects invalid bucket widths and bounds", async () => {
    const store = await sqliteStore();
    await expect(
      costTimeseries(store, { workspaceId: "default", bucketMinutes: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      costTimeseries(store, { workspaceId: "default", bucketMinutes: 1.5 }),
    ).rejects.toThrow(RangeError);
    await expect(
      costTimeseries(store, { workspaceId: "default", bucketMinutes: 1441 }),
    ).rejects.toThrow(RangeError);
    await expect(
      costTimeseries(store, { workspaceId: "default", since: "not-a-date" }),
    ).rejects.toThrow(RangeError);
  });
});
