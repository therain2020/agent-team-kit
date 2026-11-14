import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cnyToMicro, loadBudgetPolicy } from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-budget-"));
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

const NOW = new Date("2026-11-15T12:00:00.000Z");
const POLICY = loadBudgetPolicy({});

function spec() {
  return {
    run: { cny: 5 },
    stage: { cny: 2 },
    agent: { cny: 3 },
  };
}

describe("budget service (sqlite)", () => {
  it("ensures the full budget hierarchy idempotently", async () => {
    const store = await sqliteStore();
    const input = {
      workspaceId: "default",
      runId: "run_test_1",
      spec: spec(),
      stages: [{ stageId: "run_test_1:stage-a", agentId: "writer" }],
      policy: POLICY,
      now: NOW,
    };
    const first = await store.budgetService.ensureRunBudgets(input);
    expect(first.ok).toBe(true);
    expect(first.budgets.map((budget) => budget.scope).sort()).toEqual([
      "agent",
      "day",
      "month",
      "run",
      "stage",
      "workspace",
    ]);
    expect(first.runBudget?.limitCnyMicro).toBe(cnyToMicro(5));

    const second = await store.budgetService.ensureRunBudgets(input);
    expect(second.budgets).toHaveLength(6);
    expect(second.runBudget?.spentCnyMicro).toBe(0);
  });

  it("rejects an admission estimate above the remaining run budget", async () => {
    const store = await sqliteStore();
    const denied = await store.budgetService.admitRun({
      workspaceId: "default",
      runId: "run_test_2",
      spec: spec(),
      policy: POLICY,
      now: NOW,
      estimateCnyMicro: cnyToMicro(6),
    });
    expect(denied.ok).toBe(false);
    expect(denied.blocking?.scope).toBe("run");

    const allowed = await store.budgetService.admitRun({
      workspaceId: "default",
      runId: "run_test_3",
      spec: spec(),
      policy: POLICY,
      now: NOW,
      estimateCnyMicro: cnyToMicro(4),
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.blocking).toBeNull();
  });

  it("reserves, commits, releases and fires the 80% alert once", async () => {
    const store = await sqliteStore();
    const base = {
      workspaceId: "default",
      runId: "run_test_1",
      spec: spec(),
      stages: [{ stageId: "run_test_1:stage-a", agentId: "writer" }],
      policy: POLICY,
      now: NOW,
    };
    await store.budgetService.ensureRunBudgets(base);

    const first = await store.budgetService.reserve({
      workspaceId: "default",
      runId: "run_test_1",
      stageId: "run_test_1:stage-a",
      agentId: "writer",
      purpose: "model",
      amountCnyMicro: cnyToMicro(1.6),
      amountTokens: 1200,
      now: NOW,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const committed = await store.budgetService.commit(
      first.reservationId,
      { cnyMicro: cnyToMicro(1.5), tokens: 1000 },
      NOW,
    );
    expect(committed.ok).toBe(true);
    expect(committed.overshoot).toBe(false);
    expect(committed.alerts).toHaveLength(0);

    const second = await store.budgetService.reserve({
      workspaceId: "default",
      runId: "run_test_1",
      stageId: "run_test_1:stage-a",
      agentId: "writer",
      purpose: "model",
      amountCnyMicro: cnyToMicro(0.5),
      amountTokens: 500,
      now: NOW,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    const crossed = await store.budgetService.commit(
      second.reservationId,
      { cnyMicro: cnyToMicro(0.5), tokens: 500 },
      NOW,
    );
    expect(crossed.alerts.map((budget) => budget.scope)).toContain("stage");

    const stage = await store.budgetService.listBudgets({
      workspaceId: "default",
      scope: "stage",
    });
    expect(stage).toHaveLength(1);
    expect(stage[0]?.spentCnyMicro).toBe(cnyToMicro(2));
    expect(stage[0]?.alert80Cny).toBe(true);

    const repeated = await store.budgetService.reserve({
      workspaceId: "default",
      runId: "run_test_1",
      stageId: "run_test_1:stage-a",
      agentId: "writer",
      purpose: "model",
      amountCnyMicro: cnyToMicro(0.1),
      amountTokens: 100,
      now: NOW,
    });
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) {
      expect(repeated.blocking?.scope).toBe("stage");
    }
  });

  it("commits a reservation at most once", async () => {
    const store = await sqliteStore();
    await store.budgetService.ensureRunBudgets({
      workspaceId: "default",
      runId: "run_test_7",
      spec: { run: { cny: 1 } },
      policy: POLICY,
      now: NOW,
    });
    const reservation = await store.budgetService.reserve({
      workspaceId: "default",
      runId: "run_test_7",
      purpose: "model",
      amountCnyMicro: cnyToMicro(0.25),
      amountTokens: 100,
      now: NOW,
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) {
      return;
    }
    const first = await store.budgetService.commit(
      reservation.reservationId,
      { cnyMicro: cnyToMicro(0.2), tokens: 80 },
      NOW,
    );
    expect(first.ok).toBe(true);
    const second = await store.budgetService.commit(
      reservation.reservationId,
      { cnyMicro: cnyToMicro(0.2), tokens: 80 },
      NOW,
    );
    expect(second.ok).toBe(true);

    const run = (
      await store.budgetService.listBudgets({
        workspaceId: "default",
        scope: "run",
        targetPrefix: "run_test_7",
      })
    )[0];
    expect(run?.spentCnyMicro).toBe(cnyToMicro(0.2));
    const charges = await store.budgetService.listCharges({
      workspaceId: "default",
      runId: "run_test_7",
    });
    expect(charges).toHaveLength(1);
  });

  it("opens a new UTC day when a run crosses midnight", async () => {
    const store = await sqliteStore();
    await store.budgetService.ensureRunBudgets({
      workspaceId: "default",
      runId: "run_test_8",
      spec: { run: { cny: 1 } },
      policy: POLICY,
      now: NOW,
    });
    const nextDay = new Date("2026-11-16T00:05:00.000Z");
    const reservation = await store.budgetService.reserve({
      workspaceId: "default",
      runId: "run_test_8",
      purpose: "model",
      amountCnyMicro: cnyToMicro(0.1),
      amountTokens: 10,
      now: nextDay,
    });
    expect(reservation.ok).toBe(true);
    const days = await store.budgetService.listBudgets({
      workspaceId: "default",
      scope: "day",
    });
    expect(days.some((budget) => budget.targetKey === "2026-11-16")).toBe(true);
  });

  it("re-arms the 80% alert after increasing the limit", async () => {
    const store = await sqliteStore();
    await store.budgetService.ensureRunBudgets({
      workspaceId: "default",
      runId: "run_test_1",
      spec: spec(),
      stages: [{ stageId: "run_test_1:stage-a", agentId: "writer" }],
      policy: POLICY,
      now: NOW,
    });
    const reservation = await store.budgetService.reserve({
      workspaceId: "default",
      runId: "run_test_1",
      stageId: "run_test_1:stage-a",
      agentId: "writer",
      purpose: "model",
      amountCnyMicro: cnyToMicro(2),
      amountTokens: 2000,
      now: NOW,
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) {
      return;
    }
    await store.budgetService.commit(
      reservation.reservationId,
      { cnyMicro: cnyToMicro(2), tokens: 2000 },
      NOW,
    );

    const stage = (
      await store.budgetService.listBudgets({
        workspaceId: "default",
        scope: "stage",
      })
    )[0];
    expect(stage?.alert80Cny).toBe(true);
    if (!stage) {
      return;
    }
    const increased = await store.budgetService.increaseLimit(
      stage.budgetId,
      { cnyMicro: cnyToMicro(1) },
      NOW,
    );
    expect(increased.ok).toBe(true);
    expect(increased.budget?.limitCnyMicro).toBe(cnyToMicro(3));
    expect(increased.budget?.alert80Cny).toBe(false);
  });

  it("prevents concurrent reservations from overspending a run", async () => {
    const store = await sqliteStore();
    const runSpec = { run: { cny: 1 } };
    await store.budgetService.ensureRunBudgets({
      workspaceId: "default",
      runId: "run_test_4",
      spec: runSpec,
      policy: POLICY,
      now: NOW,
    });

    const attempts = await Promise.all([
      store.budgetService.reserve({
        workspaceId: "default",
        runId: "run_test_4",
        purpose: "model",
        amountCnyMicro: cnyToMicro(0.6),
        amountTokens: 100,
        now: NOW,
      }),
      store.budgetService.reserve({
        workspaceId: "default",
        runId: "run_test_4",
        purpose: "model",
        amountCnyMicro: cnyToMicro(0.6),
        amountTokens: 100,
        now: NOW,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);

    const run = (
      await store.budgetService.listBudgets({
        workspaceId: "default",
        scope: "run",
      })
    )[0];
    expect(run?.reservedCnyMicro).toBe(cnyToMicro(0.6));
    expect(
      (run?.spentCnyMicro ?? 0) + (run?.reservedCnyMicro ?? 0),
    ).toBeLessThanOrEqual(cnyToMicro(1));
  });

  it("releases expired reservations", async () => {
    const store = await sqliteStore();
    await store.budgetService.ensureRunBudgets({
      workspaceId: "default",
      runId: "run_test_5",
      spec: { run: { cny: 1 } },
      policy: POLICY,
      now: NOW,
    });
    const reservation = await store.budgetService.reserve({
      workspaceId: "default",
      runId: "run_test_5",
      purpose: "model",
      amountCnyMicro: cnyToMicro(0.5),
      amountTokens: 100,
      ttlMs: 1,
      now: NOW,
    });
    expect(reservation.ok).toBe(true);
    const released = await store.budgetService.releaseExpired(
      new Date(NOW.getTime() + 10),
      true,
    );
    expect(released).toBe(1);
    const run = (
      await store.budgetService.listBudgets({
        workspaceId: "default",
        scope: "run",
      })
    )[0];
    expect(run?.reservedCnyMicro).toBe(0);
  });

  it("refuses to raise a child beyond its parent", async () => {
    const store = await sqliteStore();
    await store.budgetService.ensureRunBudgets({
      workspaceId: "default",
      runId: "run_test_6",
      spec: spec(),
      policy: POLICY,
      now: NOW,
    });
    const month = (
      await store.budgetService.listBudgets({
        workspaceId: "default",
        scope: "month",
      })
    )[0];
    expect(month?.limitCnyMicro).toBe(cnyToMicro(200));
    if (!month) {
      return;
    }
    const refused = await store.budgetService.increaseLimit(
      month.budgetId,
      { cnyMicro: cnyToMicro(50) },
      NOW,
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("workspace");
  });
});
