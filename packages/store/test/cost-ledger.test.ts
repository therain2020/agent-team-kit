import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import type { CostRecordInput } from "../src/cost-ledger";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-cost-"));
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

function record(overrides: Partial<CostRecordInput> = {}): CostRecordInput {
  return {
    workspaceId: "default",
    runId: "run_1",
    stageId: "run_1:s1",
    agentId: "writer",
    source: "model",
    modelId: "deepseek-flash",
    provider: "deepseek",
    tokensIn: 1000,
    tokensOut: 500,
    unitPriceInMicro: 1000,
    unitPriceOutMicro: 2000,
    priceVersion: "2026-11-01",
    costCnyMicro: 2000,
    tracked: true,
    callId: "run_1:s1:call-0",
    ts: "2026-11-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("cost ledger (sqlite)", () => {
  it("records a call once per idempotency key", async () => {
    const store = await sqliteStore();
    const first = await store.costLedger.record(record());
    const second = await store.costLedger.record(record());
    expect(second.recordId).toBe(first.recordId);
    expect(second.costCnyMicro).toBe(2000);
    const rows = await store.costLedger.listRecords({
      workspaceId: "default",
      runId: "run_1",
    });
    expect(rows).toHaveLength(1);
  });

  it("keeps the price version and unit prices it was charged at", async () => {
    const store = await sqliteStore();
    await store.costLedger.record(record({ callId: "c-old" }));
    await store.costLedger.record(
      record({
        callId: "c-new",
        priceVersion: "2026-12-01",
        unitPriceInMicro: 3000,
        unitPriceOutMicro: 6000,
        tokensIn: 1000,
        tokensOut: 0,
        costCnyMicro: 3000,
      }),
    );
    const rows = await store.costLedger.listRecords({
      workspaceId: "default",
      runId: "run_1",
    });
    const old = rows.find((row) => row.callId === "c-old");
    const fresh = rows.find((row) => row.callId === "c-new");
    expect(old?.priceVersion).toBe("2026-11-01");
    expect(old?.unitPriceInMicro).toBe(1000);
    expect(fresh?.priceVersion).toBe("2026-12-01");
    expect(fresh?.costCnyMicro).toBe(3000);
  });

  it("refuses a nonzero cost on an untracked record", async () => {
    const store = await sqliteStore();
    await expect(
      store.costLedger.record(
        record({ tracked: false, untrackedReason: "unknown", costCnyMicro: 1 }),
      ),
    ).rejects.toThrow(/zero cost/);
    const stored = await store.costLedger.record(
      record({
        callId: "c-untracked",
        tracked: false,
        untrackedReason: "no price for model",
        costCnyMicro: 0,
      }),
    );
    expect(stored.tracked).toBe(false);
    expect(stored.untrackedReason).toBe("no price for model");
  });

  it("links records to the artifact version and reports unit cost", async () => {
    const store = await sqliteStore();
    await store.costLedger.record(record({ callId: "c-1" }));
    await store.costLedger.record(
      record({ callId: "c-2", stageId: "run_1:s1:gate:0", costCnyMicro: 1000 }),
    );
    const attached = await store.costLedger.attachArtifact({
      workspaceId: "default",
      runId: "run_1",
      stageId: "run_1:s1",
      artifactId: "art_1",
    });
    expect(attached).toBe(1);

    const byArtifact = await store.costLedger.listRecords({
      workspaceId: "default",
      artifactId: "art_1",
    });
    expect(byArtifact).toHaveLength(1);
    expect(byArtifact[0]?.artifactId).toBe("art_1");

    await store.costLedger.attachArtifact({
      workspaceId: "default",
      runId: "run_1",
      stageId: "run_1:s1:gate:0",
      artifactId: "art_2",
    });
    const report = await store.costLedger.artifactUnitCost({
      workspaceId: "default",
      since: "2026-11-01T00:00:00.000Z",
      until: "2026-12-01T00:00:00.000Z",
    });
    expect(report.artifactCount).toBe(2);
    expect(report.totalCostCnyMicro).toBe(3000);
    expect(report.averageUnitCostCnyMicro).toBe(1500);
    expect(report.artifacts[0]?.artifactId).toBe("art_1");
  });

  it("aggregates daily cost and flags z-score anomalies", async () => {
    const store = await sqliteStore();
    let index = 0;
    const day = (dayKey: string, cost: number) =>
      store.costLedger.record(
        record({
          callId: `c-${index++}`,
          costCnyMicro: cost,
          ts: `${dayKey}T12:00:00.000Z`,
        }),
      );
    await day("2026-11-01", 1000);
    await day("2026-11-02", 1200);
    await day("2026-11-03", 900);
    await day("2026-11-04", 50000);

    const daily = await store.costLedger.dailyCost({
      workspaceId: "default",
      since: "2026-11-01T00:00:00.000Z",
      until: "2026-11-05T00:00:00.000Z",
    });
    expect(daily.map((row) => row.dayKey)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ]);
    expect(daily.at(-1)?.costCnyMicro).toBe(50000);

    const anomalies = await store.costLedger.anomalies({
      workspaceId: "default",
      until: "2026-11-05T00:00:00.000Z",
      baselineDays: 5,
    });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.dayKey).toBe("2026-11-04");
    expect(anomalies[0]?.zScore).toBeGreaterThan(3);
  });

  it("reconciles the ledger against an imported bill within 2%", async () => {
    const store = await sqliteStore();
    await store.costLedger.record(
      record({
        callId: "c-a",
        costCnyMicro: 600_000,
        ts: "2026-11-02T10:00:00.000Z",
      }),
    );
    await store.costLedger.record(
      record({
        callId: "c-b",
        costCnyMicro: 390_000,
        ts: "2026-11-03T10:00:00.000Z",
      }),
    );
    // Fixture statement: ¥1.00 for a ledger total of ¥0.99 (1% off).
    await store.costLedger.importProviderBill({
      workspaceId: "default",
      provider: "deepseek",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      amountCnyMicro: 1_000_000,
      source: "fixture-deepseek-2026-11.csv",
    });
    // Importing the same statement twice must not double the bill.
    await store.costLedger.importProviderBill({
      workspaceId: "default",
      provider: "deepseek",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      amountCnyMicro: 1_000_000,
      source: "fixture-deepseek-2026-11.csv",
    });

    const report = await store.costLedger.reconcile({
      workspaceId: "default",
      since: "2026-11-01T00:00:00.000Z",
      until: "2026-11-30T00:00:00.000Z",
    });
    expect(report.billedCnyMicro).toBe(1_000_000);
    expect(report.ledgerCnyMicro).toBe(990_000);
    expect(report.diffRatio).toBeCloseTo(0.01, 4);
    expect(report.ok).toBe(true);
    expect(report.rows[0]?.provider).toBe("deepseek");
  });

  it("flags reconciliation beyond 2% and ignores untracked calls", async () => {
    const store = await sqliteStore();
    await store.costLedger.record(
      record({ callId: "c-x", costCnyMicro: 900_000 }),
    );
    await store.costLedger.record(
      record({
        callId: "c-unpriced",
        tracked: false,
        costCnyMicro: 0,
        untrackedReason: "unknown model",
        provider: "unknown",
      }),
    );
    await store.costLedger.importProviderBill({
      workspaceId: "default",
      provider: "deepseek",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      amountCnyMicro: 1_000_000,
      source: "fixture-deepseek-2026-11.csv",
    });
    const report = await store.costLedger.reconcile({
      workspaceId: "default",
      since: "2026-11-01T00:00:00.000Z",
      until: "2026-11-30T00:00:00.000Z",
    });
    expect(report.ok).toBe(false);
    expect(report.ledgerCnyMicro).toBe(900_000);
    expect(report.untrackedCalls).toBe(1);
  });

  it("stores price table versions for audit", async () => {
    const store = await sqliteStore();
    const table = {
      version: "2026-11-01",
      effectiveAt: "2026-11-01T00:00:00.000Z",
      entries: [
        {
          modelId: "deepseek-flash",
          provider: "deepseek",
          currency: "CNY",
          inputPer1k: 0.001,
          outputPer1k: 0.002,
          effectiveAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    };
    await store.costLedger.registerPriceTable(table);
    const stored = await store.costLedger.getPriceTable("2026-11-01");
    expect(stored?.entries).toHaveLength(1);
    expect(stored?.effectiveAt).toBe("2026-11-01T00:00:00.000Z");
  });
});
