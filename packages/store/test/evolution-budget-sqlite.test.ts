import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cnyToMicro, loadBudgetPolicy } from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import { listOps } from "../src/op-log";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-evolution-budget-"));
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
const SHARE = 0.1;
const POLICY = loadBudgetPolicy({
  KIT_BUDGET_RUN_CNY: "5",
  KIT_BUDGET_DAY_CNY: "30",
  KIT_BUDGET_MONTH_CNY: "200",
  KIT_BUDGET_WORKSPACE_CNY: "200",
});

describe("evolution budget subject (sqlite)", () => {
  it("sizes the evolution subject at 10% of the production month budget", async () => {
    const store = await sqliteStore();
    const ensured = await store.budgetService.ensureEvolutionBudget({
      workspaceId: "default",
      policy: POLICY,
      share: SHARE,
      now: NOW,
    });
    expect(ensured.ok).toBe(true);
    expect(ensured.share).toBe(0.1);
    expect(ensured.monthKey).toBe("2026-11");
    expect(ensured.budget?.scope).toBe("evolution");
    expect(ensured.budget?.limitCnyMicro).toBe(cnyToMicro(20));

    // The subject is independent: no production rows were created.
    const all = await store.budgetService.listBudgets({
      workspaceId: "default",
    });
    expect(all.map((budget) => budget.scope)).toEqual(["evolution"]);

    const denied = await store.budgetService.admitEvolution({
      workspaceId: "default",
      estimateCnyMicro: cnyToMicro(20.01),
      policy: POLICY,
      share: SHARE,
      now: NOW,
    });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("below the cycle estimate");

    const admitted = await store.budgetService.admitEvolution({
      workspaceId: "default",
      estimateCnyMicro: cnyToMicro(20),
      policy: POLICY,
      share: SHARE,
      now: NOW,
    });
    expect(admitted.ok).toBe(true);
    expect(admitted.remainingCnyMicro).toBe(cnyToMicro(20));
  });

  it("reserves, commits and reconciles per cycle without touching production", async () => {
    const store = await sqliteStore();
    const reserved = await store.budgetService.reserveEvolution({
      workspaceId: "default",
      cycleId: "cyc_budget_1",
      phase: "proposal",
      amountCnyMicro: cnyToMicro(5),
      amountTokens: 1000,
      policy: POLICY,
      share: SHARE,
      now: NOW,
    });
    expect(reserved.ok).toBe(true);
    expect(reserved.reservationId).toBeTruthy();

    const committed = await store.budgetService.commitEvolution(
      reserved.reservationId ?? "",
      { cnyMicro: cnyToMicro(4), tokens: 800 },
      NOW,
    );
    expect(committed.ok).toBe(true);
    expect(committed.chargeId).toBeTruthy();

    const reconciliation = await store.budgetService.reconcileEvolution({
      workspaceId: "default",
      cycleId: "cyc_budget_1",
    });
    expect(reconciliation.chargedCnyMicro).toBe(cnyToMicro(4));
    expect(reconciliation.chargedTokens).toBe(800);
    expect(reconciliation.chargeIds).toEqual([committed.chargeId]);
    expect(reconciliation.reservationIds).toEqual([reserved.reservationId]);

    // 20 CNY limit − 4 CNY spent leaves 16 CNY; the next phase fits exactly.
    const fits = await store.budgetService.reserveEvolution({
      workspaceId: "default",
      cycleId: "cyc_budget_1",
      phase: "score",
      amountCnyMicro: cnyToMicro(16),
      amountTokens: 0,
      policy: POLICY,
      share: SHARE,
      now: NOW,
    });
    expect(fits.ok).toBe(true);

    // While that phase is reserved the hard cap is already consumed.
    const blocked = await store.budgetService.reserveEvolution({
      workspaceId: "default",
      cycleId: "cyc_budget_1",
      phase: "canary",
      amountCnyMicro: cnyToMicro(1),
      amountTokens: 0,
      policy: POLICY,
      share: SHARE,
      now: NOW,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("evolution budget reached");

    const ops = await listOps(store, { workspaceId: "default", limit: 50 });
    expect(
      ops.some(
        (op) =>
          op.op === "budget.reserve.denied" &&
          (op.payload as { purpose?: string }).purpose === "evolution:canary",
      ),
    ).toBe(true);

    const budgets = await store.budgetService.listBudgets({
      workspaceId: "default",
      scope: "evolution",
    });
    expect(budgets).toHaveLength(1);
    expect(budgets[0]?.spentCnyMicro).toBe(cnyToMicro(4));
    expect(budgets[0]?.reservedCnyMicro).toBe(cnyToMicro(16));
  });

  it("releases reservations that never become charges", async () => {
    const store = await sqliteStore();
    const reserved = await store.budgetService.reserveEvolution({
      workspaceId: "default",
      cycleId: "cyc_budget_2",
      phase: "score",
      amountCnyMicro: cnyToMicro(5),
      amountTokens: 0,
      policy: POLICY,
      share: SHARE,
      now: NOW,
    });
    expect(reserved.ok).toBe(true);
    await store.budgetService.releaseEvolution(
      reserved.reservationId ?? "",
      NOW,
    );

    const reconciliation = await store.budgetService.reconcileEvolution({
      workspaceId: "default",
      cycleId: "cyc_budget_2",
    });
    expect(reconciliation.chargedCnyMicro).toBe(0);
    expect(reconciliation.chargeIds).toEqual([]);

    const budgets = await store.budgetService.listBudgets({
      workspaceId: "default",
      scope: "evolution",
    });
    expect(budgets[0]?.reservedCnyMicro).toBe(0);
    expect(budgets[0]?.spentCnyMicro).toBe(0);
  });
});
