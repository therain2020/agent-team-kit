import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AttributionRecord,
  appendAttributionRecord,
  applyAttributionOutcome,
  buildAttributionRecord,
  compareFitnessWindows,
  fitnessWindowOf,
  loadAttributionRecords,
  selectAttributionWindows,
} from "../src/attribution";
import { loadFreezeState } from "../src/freeze";
import { loadGovernanceEvents } from "../src/governance";
import {
  type ChangeRevertService,
  type RevertibleProposal,
  revertChangeProposal,
} from "../src/revert";
import type { IterationSignal } from "../src/signals";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kit-attribution-"));
  roots.push(root);
  return root;
}

function signal(
  overrides: Partial<IterationSignal> & { taskId: string },
): IterationSignal {
  const { taskId, ...rest } = overrides;
  return {
    at: "2026-11-20T00:00:00.000Z",
    iterationId: `it_${taskId}`,
    taskId,
    domain: "web",
    coder: "dsh",
    verified: true,
    applied: true,
    risk: "low",
    tokens: 100,
    ...rest,
  };
}

function championWindow(): IterationSignal[] {
  return [0, 1, 2, 3, 4, 5].map((index) =>
    signal({
      taskId: `champion_${index}`,
      at: `2026-11-20T0${index}:00:00.000Z`,
    }),
  );
}

function changedWindow(verifiedCount: number): IterationSignal[] {
  return [0, 1, 2, 3, 4, 5].map((index) =>
    signal({
      taskId: `canary_${index}`,
      at: `2026-11-20T0${index}:30:00.000Z`,
      changeId: "var_bad",
      changeStage: "canary",
      verified: index < verifiedCount,
      applied: index < verifiedCount,
    }),
  );
}

class FakeRevertService implements ChangeRevertService {
  readonly calls: Array<{ proposalId: string; trigger: string }> = [];
  constructor(private readonly proposal: RevertibleProposal | null) {}

  async get(): Promise<RevertibleProposal | null> {
    return this.proposal;
  }

  async transition(input: {
    proposalId: string;
    trigger: "rollback";
    actor: string;
    reason: string;
  }) {
    this.calls.push({ proposalId: input.proposalId, trigger: input.trigger });
    return {
      ok: true as const,
      proposal: this.proposal ?? {
        id: input.proposalId,
        state: "rolled_back" as const,
        revertRef: "variant:baseline",
      },
      transition: { auditId: "aud_rollback" },
    };
  }
}

describe("live attribution windows", () => {
  it("prefers champion traffic concurrent with the change", () => {
    const signals = [
      ...championWindow(),
      signal({
        taskId: "old_champion",
        at: "2026-11-19T10:00:00.000Z",
      }),
      ...changedWindow(6),
    ];
    const windows = selectAttributionWindows(signals, "var_bad");
    expect(windows.changed).toHaveLength(6);
    // Champion traffic overlapping the change window is the baseline.
    expect(windows.baseline).toHaveLength(5);
    expect(windows.baseline.every((item) => !item.changeId)).toBe(true);
  });

  it("falls back to the preceding lookback when no champion overlapped", () => {
    const signals = [
      signal({ taskId: "pre_1", at: "2026-11-18T00:00:00.000Z" }),
      signal({ taskId: "pre_2", at: "2026-11-19T00:00:00.000Z" }),
      signal({
        taskId: "canary_1",
        at: "2026-11-20T00:00:00.000Z",
        changeId: "var_canary",
      }),
    ];
    const windows = selectAttributionWindows(signals, "var_canary");
    expect(windows.changed).toHaveLength(1);
    expect(windows.baseline.map((item) => item.taskId)).toEqual([
      "pre_1",
      "pre_2",
    ]);
  });

  it("computes pass, apply, cost, risk and incident metrics", () => {
    const window = fitnessWindowOf([
      signal({ taskId: "a", risk: "high" }),
      signal({ taskId: "b", verified: false, applied: false, error: "boom" }),
      signal({ taskId: "c", tokens: 300, risk: "high", applied: false }),
    ]);
    expect(window.tasks).toBe(3);
    expect(window.passRate).toBe(0.6667);
    expect(window.applyRate).toBe(0.5);
    expect(window.avgTokens).toBe(167);
    expect(window.highRiskShare).toBe(0.6667);
    expect(window.incidentRate).toBe(0.3333);
  });
});

describe("divergence detection", () => {
  it("flags offline score up with live pass-rate down", () => {
    const record = buildAttributionRecord({
      changeId: "var_bad",
      signals: [...championWindow(), ...changedWindow(2)],
      offlineScoreDelta: 0.12,
    });
    expect(record.verdict).toBe("divergent");
    expect(record.divergent).toBe(true);
    expect(record.reasons.join(" ")).toContain("pass rate fell");
    expect(record.baseline.passRate).toBe(1);
    expect(record.changed.passRate).toBe(0.3333);
    expect(record.stage).toBe("canary");
  });

  it("does not flag an identical baseline window (no false positive)", () => {
    const record = buildAttributionRecord({
      changeId: "var_healthy",
      signals: [
        ...championWindow(),
        ...changedWindow(6).map((item) => ({
          ...item,
          changeId: "var_healthy",
        })),
      ],
      offlineScoreDelta: 0.12,
    });
    expect(record.divergent).toBe(false);
    expect(record.reasons).toEqual([]);
    expect(record.verdict).toBe("flat");
  });

  it("requires enough tasks in both windows", () => {
    const record = buildAttributionRecord({
      changeId: "var_small",
      signals: [
        ...championWindow(),
        signal({
          taskId: "canary_single",
          changeId: "var_small",
          verified: false,
          applied: false,
        }),
      ],
      offlineScoreDelta: 0.2,
    });
    expect(record.verdict).toBe("insufficient_data");
    expect(record.divergent).toBe(false);
  });

  it("reports a live regression without offline evidence as regressed, not divergent", () => {
    const comparison = compareFitnessWindows(
      fitnessWindowOf(championWindow()),
      fitnessWindowOf(changedWindow(2)),
      { offlineScoreDelta: -0.05 },
    );
    expect(comparison.divergent).toBe(false);
    expect(comparison.verdict).toBe("regressed");
    expect(comparison.reasons.length).toBeGreaterThan(0);
  });

  it("treats a cost blow-up as a real regression", () => {
    const changed = changedWindow(6).map((item) => ({
      ...item,
      tokens: 400,
    }));
    const comparison = compareFitnessWindows(
      fitnessWindowOf(championWindow()),
      fitnessWindowOf(changed),
      { offlineScoreDelta: 0.1 },
    );
    expect(comparison.divergent).toBe(true);
    expect(comparison.reasons.join(" ")).toContain("cost per task");
  });
});

describe("attribution actuation", () => {
  it("pauses evolution and reverts the change through revertRef", async () => {
    const root = await makeRoot();
    const freezePath = path.join(root, "freeze.json");
    const governancePath = path.join(root, "governance.jsonl");
    const service = new FakeRevertService({
      id: "chg_1",
      state: "promoted",
      revertRef: "variant:baseline",
    });
    const record = buildAttributionRecord({
      changeId: "var_bad",
      workspaceId: "default",
      signals: [...championWindow(), ...changedWindow(2)],
      offlineScoreDelta: 0.12,
    });

    const applied = await applyAttributionOutcome({
      record,
      freeze: { freezePath },
      governancePath,
      revert: { service, proposalId: "chg_1" },
    });

    expect(applied.actions.paused).toBe(true);
    expect(applied.actions.freezeKind).toBe("divergence");
    expect(applied.actions.rollback?.status).toBe("rolled_back");
    expect(applied.actions.rollback?.revertRef).toBe("variant:baseline");
    expect(applied.actions.rollback?.auditId).toBe("aud_rollback");
    expect(service.calls).toEqual([
      { proposalId: "chg_1", trigger: "rollback" },
    ]);

    const freeze = await loadFreezeState({ freezePath });
    expect(freeze.status).toBe("frozen");
    expect(freeze.kind).toBe("divergence");

    const events = await loadGovernanceEvents(governancePath, 5);
    expect(events[0]?.kind).toBe("attribution");
    expect(events[0]?.action).toBe("rollback");
    expect(events[0]?.reason).toContain("var_bad");
  });

  it("has no side effects for a healthy window", async () => {
    const root = await makeRoot();
    const freezePath = path.join(root, "freeze.json");
    const governancePath = path.join(root, "governance.jsonl");
    const service = new FakeRevertService({
      id: "chg_1",
      state: "promoted",
      revertRef: "variant:baseline",
    });
    const record = buildAttributionRecord({
      changeId: "var_healthy",
      signals: [
        ...championWindow(),
        ...changedWindow(6).map((item) => ({
          ...item,
          changeId: "var_healthy",
        })),
      ],
      offlineScoreDelta: 0.12,
    });

    const applied = await applyAttributionOutcome({
      record,
      freeze: { freezePath },
      governancePath,
      revert: { service, proposalId: "chg_1" },
    });

    expect(applied.actions.paused).toBe(false);
    expect(applied.actions.rollback).toBeNull();
    expect(service.calls).toEqual([]);
    expect(existsSync(freezePath)).toBe(false);
    expect(existsSync(governancePath)).toBe(false);
  });

  it("records the pause without reverting when no proposal is linked", async () => {
    const root = await makeRoot();
    const service = new FakeRevertService(null);
    const record = buildAttributionRecord({
      changeId: "var_bad",
      signals: [...championWindow(), ...changedWindow(2)],
      offlineScoreDelta: 0.12,
    });
    const applied = await applyAttributionOutcome({
      record,
      freeze: { freezePath: path.join(root, "freeze.json") },
      governancePath: path.join(root, "governance.jsonl"),
      revert: { service, proposalId: null },
    });
    expect(applied.actions.paused).toBe(true);
    expect(applied.actions.rollback?.status).toBe("skipped");
    expect(applied.actions.rollback?.reason).toContain(
      "no unified change proposal",
    );
    expect(service.calls).toEqual([]);
  });
});

describe("unified revert", () => {
  it("rolls back a promotable proposal and returns its audit row", async () => {
    const service = new FakeRevertService({
      id: "chg_1",
      state: "promoted",
      revertRef: "commit:abc123",
    });
    const outcome = await revertChangeProposal(service, {
      proposalId: "chg_1",
      reason: "live divergence",
    });
    expect(outcome.status).toBe("rolled_back");
    expect(outcome.auditId).toBe("aud_rollback");
    expect(outcome.revertRef).toBe("commit:abc123");
  });

  it("refuses to roll back without a revertRef", async () => {
    const service = new FakeRevertService({
      id: "chg_1",
      state: "promoted",
      revertRef: null,
    });
    const outcome = await revertChangeProposal(service, {
      proposalId: "chg_1",
      reason: "live divergence",
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("no revertRef");
    expect(service.calls).toEqual([]);
  });

  it("handles a missing proposal and an already rolled-back one", async () => {
    const missing = await revertChangeProposal(new FakeRevertService(null), {
      proposalId: "chg_missing",
      reason: "live divergence",
    });
    expect(missing.status).toBe("skipped");

    const done = await revertChangeProposal(
      new FakeRevertService({
        id: "chg_1",
        state: "rolled_back",
        revertRef: "commit:abc123",
      }),
      { proposalId: "chg_1", reason: "live divergence" },
    );
    expect(done.status).toBe("already_rolled_back");
  });
});

describe("attribution persistence", () => {
  it("round-trips records and skips corrupt lines", async () => {
    const root = await makeRoot();
    const file = path.join(root, "attribution.jsonl");
    const record = buildAttributionRecord({
      changeId: "var_bad",
      signals: [...championWindow(), ...changedWindow(2)],
      offlineScoreDelta: 0.12,
      now: "2026-11-20T12:00:00.000Z",
    });
    await appendAttributionRecord(record, file);
    await writeFile(
      file,
      `${await readFile(file, "utf8")}{not json}\n`,
      "utf8",
    );

    const loaded = await loadAttributionRecords(file, 10);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.attributionId).toBe(record.attributionId);
    expect(loaded[0]?.verdict).toBe("divergent");

    const typed: AttributionRecord = loaded[0] as AttributionRecord;
    expect(typed.changed.tasks).toBe(6);
  });
});
