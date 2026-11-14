import { describe, expect, it } from "vitest";
import {
  type CanaryState,
  bucketForRun,
  decideRollback,
  selectRunVariant,
} from "../src/canary";
import type { EvolutionRecord } from "../src/evolve";

function canaryState(
  overrides: Partial<NonNullable<CanaryState["canary"]>> = {},
  workspaceId = "ws-a",
): CanaryState {
  return {
    workspaceId,
    champion: { path: "/champion" },
    canary: {
      path: "/candidate",
      variantId: "var_canary",
      agentId: "writer",
      trafficPercent: 20,
      status: "canary",
      since: "2026-01-01T00:00:00.000Z",
      ...overrides,
    },
  };
}

function record(
  pass: boolean,
  score: number,
  costCny: number,
): EvolutionRecord {
  return {
    variantId: "v",
    name: "n",
    parent: null,
    agentId: "writer",
    stub: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    pass,
    scores: { quality: score },
    rationale: "",
    costCny,
    tokens: 0,
    draftChars: 100,
  };
}

function findRunBelow(percent: number): string {
  for (let index = 0; index < 10_000; index += 1) {
    const runId = `run_${index}`;
    if (bucketForRun(runId) < percent) {
      return runId;
    }
  }
  throw new Error(`no runId below ${percent}%`);
}

describe("canary traffic bucketing", () => {
  it("is deterministic for a given runId", () => {
    const runId = "run_stable";
    expect(bucketForRun(runId)).toBe(bucketForRun(runId));
    expect(selectRunVariant(canaryState(), runId, "ws-a")).toEqual(
      selectRunVariant(canaryState(), runId, "ws-a"),
    );
  });

  it("routes roughly the configured percentage", () => {
    const total = 20_000;
    let hits = 0;
    const state = canaryState();
    for (let index = 0; index < total; index += 1) {
      if (selectRunVariant(state, `run_${index}`, "ws-a")) {
        hits += 1;
      }
    }
    const ratio = hits / total;
    expect(ratio).toBeGreaterThan(0.18);
    expect(ratio).toBeLessThan(0.22);
  });

  it("never leaks across workspaces", () => {
    const runId = findRunBelow(20);
    expect(selectRunVariant(canaryState(), runId, "ws-a")).not.toBeNull();
    expect(selectRunVariant(canaryState(), runId, "ws-b")).toBeNull();
  });

  it("only routes when the canary is live", () => {
    const runId = findRunBelow(20);
    for (const status of ["shadow", "promoted", "rolled_back"] as const) {
      expect(
        selectRunVariant(canaryState({ status }), runId, "ws-a"),
      ).toBeNull();
    }
    expect(
      selectRunVariant(canaryState({ trafficPercent: 0 }), runId, "ws-a"),
    ).toBeNull();
  });
});

describe("canary rollback triggers", () => {
  it("rolls back on incident", () => {
    const decision = decideRollback([record(true, 0.9, 0.01)], [], {
      incident: "upstream outage",
    });
    expect(decision).toEqual({
      rollback: true,
      trigger: "incident",
      reason: "incident: upstream outage",
    });
  });

  it("rolls back when pass rate drops", () => {
    const decision = decideRollback(
      [record(true, 0.9, 0.01)],
      [record(false, 0.9, 0.01)],
    );
    expect(decision.rollback).toBe(true);
    expect(decision.trigger).toBe("pass_rate");
  });

  it("rolls back when average score drops", () => {
    const decision = decideRollback(
      [record(true, 0.9, 0.01)],
      [record(true, 0.5, 0.01)],
    );
    expect(decision.rollback).toBe(true);
    expect(decision.trigger).toBe("score");
  });

  it("rolls back when cost exceeds the threshold", () => {
    const decision = decideRollback(
      [record(true, 0.9, 0.01)],
      [record(true, 0.9, 0.02)],
    );
    expect(decision.rollback).toBe(true);
    expect(decision.trigger).toBe("cost");
  });

  it("keeps a healthy canary", () => {
    expect(
      decideRollback([record(true, 0.9, 0.01)], [record(true, 0.9, 0.01)])
        .rollback,
    ).toBe(false);
  });
});
