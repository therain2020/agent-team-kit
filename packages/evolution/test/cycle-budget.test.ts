import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  EvolutionBudgetAdmitInput,
  EvolutionBudgetAdmitResult,
  EvolutionBudgetCommitResult,
  EvolutionBudgetLedger,
  EvolutionBudgetPhase,
  EvolutionBudgetReconcileResult,
  EvolutionBudgetReserveInput,
  EvolutionBudgetReserveResult,
} from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { runEvolutionCycle } from "../src/cycle";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeEvidence(root: string): Promise<string> {
  const inputFile = path.join(root, "evidence.json");
  await writeFile(
    inputFile,
    JSON.stringify({
      generatedAt: "2026-11-14T00:00:00.000Z",
      sources: [
        {
          citationId: "S1",
          title: "Example",
          url: "https://example.com/a",
          summary: "A verifiable item.",
        },
      ],
      errors: [],
    }),
    "utf8",
  );
  return inputFile;
}

/**
 * Fake ledger: no database, no real bill. It records what the cycle asked for
 * so the test can assert admission, per-phase accounting and reconciliation.
 */
class FakeEvolutionLedger implements EvolutionBudgetLedger {
  admitResult: { ok: boolean; reason: string | null } = {
    ok: true,
    reason: null,
  };
  denyPhase?: EvolutionBudgetPhase;
  overshootPhase?: EvolutionBudgetPhase;
  admitCalls = 0;
  extraChargedCnyMicro = 0;
  releases: string[] = [];
  private reservations = new Map<
    string,
    { cycleId: string; phase: EvolutionBudgetPhase }
  >();
  private charges: Array<{
    reservationId: string;
    cycleId: string;
    phase: EvolutionBudgetPhase;
    chargeId: string;
    cnyMicro: number;
    tokens: number;
  }> = [];
  private seq = 0;

  chargedPhases(): EvolutionBudgetPhase[] {
    return this.charges.map((charge) => charge.phase);
  }

  async admitEvolution(
    _input: EvolutionBudgetAdmitInput,
  ): Promise<EvolutionBudgetAdmitResult> {
    this.admitCalls += 1;
    return {
      ok: this.admitResult.ok,
      reason: this.admitResult.reason,
      budgetId: "bdg_fake",
      limitCnyMicro: 20_000_000,
      limitTokens: null,
      remainingCnyMicro: 20_000_000,
      remainingTokens: null,
      share: 0.1,
    };
  }

  async reserveEvolution(
    input: EvolutionBudgetReserveInput,
  ): Promise<EvolutionBudgetReserveResult> {
    if (this.denyPhase === input.phase) {
      return {
        ok: false,
        reservationId: null,
        budgetId: "bdg_fake",
        message: `${input.phase} denied by fake ledger`,
      };
    }
    const reservationId = `brs_fake_${++this.seq}`;
    this.reservations.set(reservationId, {
      cycleId: input.cycleId,
      phase: input.phase,
    });
    return {
      ok: true,
      reservationId,
      budgetId: "bdg_fake",
      message: null,
    };
  }

  async commitEvolution(
    reservationId: string,
    actual: { cnyMicro: number; tokens: number },
  ): Promise<EvolutionBudgetCommitResult> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      return {
        ok: false,
        chargeId: null,
        overshoot: false,
        message: "reservation missing",
      };
    }
    const chargeId = `bch_fake_${++this.seq}`;
    this.charges.push({
      reservationId,
      cycleId: reservation.cycleId,
      phase: reservation.phase,
      chargeId,
      cnyMicro: actual.cnyMicro,
      tokens: actual.tokens,
    });
    this.reservations.delete(reservationId);
    return {
      ok: true,
      chargeId,
      overshoot: reservation.phase === this.overshootPhase,
    };
  }

  async releaseEvolution(reservationId: string): Promise<void> {
    this.releases.push(reservationId);
    this.reservations.delete(reservationId);
  }

  async reconcileEvolution(input: {
    workspaceId: string;
    cycleId: string;
  }): Promise<EvolutionBudgetReconcileResult> {
    const rows = this.charges.filter(
      (charge) => charge.cycleId === input.cycleId,
    );
    return {
      chargedCnyMicro:
        rows.reduce((sum, charge) => sum + charge.cnyMicro, 0) +
        this.extraChargedCnyMicro,
      chargedTokens: rows.reduce((sum, charge) => sum + charge.tokens, 0),
      chargeIds: rows.map((charge) => charge.chargeId),
      reservationIds: rows.map((charge) => charge.reservationId),
    };
  }
}

async function runStubCycle(input: {
  root: string;
  inputFile: string;
  budget: EvolutionBudgetLedger;
  budgetCny?: number;
}) {
  const variantsRoot = path.join(input.root, "variants");
  return await runEvolutionCycle({
    packDir: path.join(process.cwd(), "packs", "tech-radar"),
    agentId: "writer",
    inputFile: input.inputFile,
    stub: true,
    force: true,
    autoApply: false,
    cyclesRoot: path.join(input.root, "cycles"),
    variantsRoot,
    archivePath: path.join(variantsRoot, "archive.jsonl"),
    cyclesPath: path.join(variantsRoot, "cycles.jsonl"),
    statePath: path.join(variantsRoot, "state.json"),
    budget: input.budget,
    ...(input.budgetCny === undefined ? {} : { budgetCny: input.budgetCny }),
  });
}

describe("evolution cycle budget gate", () => {
  it("skips before any model call when the subject has no headroom", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kit-cycle-budget-"));
    roots.push(root);
    const inputFile = await writeEvidence(root);
    const ledger = new FakeEvolutionLedger();
    ledger.admitResult = { ok: false, reason: "evolution budget exhausted" };

    const record = await runStubCycle({ root, inputFile, budget: ledger });

    expect(record.decision).toBe("skipped");
    expect(record.budgetStatus).toBe("budget_exceeded");
    expect(record.rationale).toContain("budget_exceeded before admission");
    expect(record.rationale).toContain("evolution budget exhausted");
    expect(record.budgetRefs ?? []).toEqual([]);
    expect(ledger.admitCalls).toBe(1);
    expect(ledger.chargedPhases()).toEqual([]);
    expect(record.budgetReconciliation?.chargeIds).toEqual([]);
  }, 30_000);

  it("charges proposal, score and canary exactly once and reconciles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kit-cycle-budget-"));
    roots.push(root);
    const inputFile = await writeEvidence(root);
    const ledger = new FakeEvolutionLedger();

    const record = await runStubCycle({ root, inputFile, budget: ledger });

    expect(record.decision).toBe("canary");
    expect(record.budgetStatus).toBe("admitted");
    expect(ledger.chargedPhases()).toEqual(["proposal", "score", "canary"]);
    const refs = record.budgetRefs ?? [];
    expect(refs.map((ref) => ref.phase)).toEqual([
      "proposal",
      "score",
      "canary",
    ]);
    for (const ref of refs) {
      expect(ref.reservationId).toBeTruthy();
      expect(ref.chargeId).toBeTruthy();
      expect(ref.purpose).toBe(`evolution:${ref.phase}`);
    }
    expect(record.budgetReconciliation?.ok).toBe(true);
    expect(record.budgetReconciliation?.deltaCnyMicro).toBe(0);
    expect(record.budgetReconciliation?.ledgerCnyMicro).toBe(
      record.budgetReconciliation?.cycleCnyMicro,
    );
  }, 30_000);

  it("stops mid-cycle when a later phase is denied", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kit-cycle-budget-"));
    roots.push(root);
    const inputFile = await writeEvidence(root);
    const ledger = new FakeEvolutionLedger();
    ledger.denyPhase = "score";

    const record = await runStubCycle({ root, inputFile, budget: ledger });

    expect(record.decision).toBe("skipped");
    expect(record.budgetStatus).toBe("budget_exceeded");
    expect(record.rationale).toContain("budget_exceeded before score");
    expect((record.budgetRefs ?? []).map((ref) => ref.phase)).toEqual([
      "proposal",
    ]);
    expect(ledger.chargedPhases()).toEqual(["proposal"]);
  }, 30_000);

  it("enforces the per-cycle budget before admitting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kit-cycle-budget-"));
    roots.push(root);
    const inputFile = await writeEvidence(root);
    const ledger = new FakeEvolutionLedger();

    const record = await runStubCycle({
      root,
      inputFile,
      budget: ledger,
      budgetCny: 0.000001,
    });

    expect(record.decision).toBe("skipped");
    expect(record.budgetStatus).toBe("budget_exceeded");
    expect(record.rationale).toContain("configured cycle budget");
    expect(ledger.chargedPhases()).toEqual([]);
  }, 30_000);

  it("pauses the remaining phases after an overshoot is booked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kit-cycle-budget-"));
    roots.push(root);
    const inputFile = await writeEvidence(root);
    const ledger = new FakeEvolutionLedger();
    ledger.overshootPhase = "proposal";

    const record = await runStubCycle({ root, inputFile, budget: ledger });

    expect(record.decision).toBe("skipped");
    expect(record.budgetStatus).toBe("budget_exceeded");
    expect(record.rationale).toContain("overshot the evolution budget");
    expect(ledger.chargedPhases()).toEqual(["proposal"]);
    expect((record.budgetRefs ?? []).map((ref) => ref.overshoot)).toEqual([
      true,
    ]);
  }, 30_000);

  it("flags a ledger that disagrees with the cycle record", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kit-cycle-budget-"));
    roots.push(root);
    const inputFile = await writeEvidence(root);
    const ledger = new FakeEvolutionLedger();
    ledger.extraChargedCnyMicro = 100;

    const record = await runStubCycle({ root, inputFile, budget: ledger });

    expect(record.budgetReconciliation?.ok).toBe(false);
    expect(record.budgetReconciliation?.deltaCnyMicro).toBe(100);
  }, 30_000);
});
