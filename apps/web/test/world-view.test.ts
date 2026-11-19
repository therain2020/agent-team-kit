import { describe, expect, it } from "vitest";
import {
  type WorldRunMetaMap,
  type WorldRunView,
  progressPercent,
  runKind,
  splitWorldRuns,
} from "../lib/world-view";

function run(
  overrides: Partial<WorldRunView> & { runId: string },
): WorldRunView {
  return {
    workspaceId: "default",
    status: "running",
    currentStage: null,
    progress: 0,
    costCny: 0,
    tokens: 0,
    artifactCount: 0,
    waitReason: null,
    lastEventId: 1,
    version: 1,
    updatedAt: "2026-11-19T09:00:00.000Z",
    ...overrides,
  };
}

describe("world kind and split", () => {
  const nowMs = new Date("2026-11-19T12:00:00.000").getTime();
  const metas: WorldRunMetaMap = {
    run_live: { kind: "run", startedAt: "2026-11-19T09:00:00.000" },
    run_wait: { kind: "run", startedAt: "2026-11-19T08:00:00.000" },
    run_ok: { kind: "run", startedAt: "2026-11-19T07:00:00.000" },
    run_bad: { kind: "run", startedAt: "2026-11-19T06:00:00.000" },
    it_1: { kind: "iteration", startedAt: "2026-11-18T20:00:00.000" },
  };

  it("classifies iterations by metadata and by id prefix", () => {
    expect(runKind(metas, "it_1")).toBe("iteration");
    expect(runKind({}, "it_abc")).toBe("iteration");
    expect(runKind({}, "run_abc")).toBe("run");
  });

  it("splits into exception-first columns with today stats", () => {
    const runs = [
      run({
        runId: "run_live",
        status: "running",
        progress: 0.5,
        costCny: 1,
        artifactCount: 2,
        updatedAt: "2026-11-19T11:55:00.000",
      }),
      run({
        runId: "run_wait",
        status: "paused",
        waitReason: "approval required",
        costCny: 2,
        artifactCount: 1,
        updatedAt: "2026-11-19T11:50:00.000",
      }),
      run({
        runId: "run_ok",
        status: "succeeded",
        costCny: 3,
        artifactCount: 4,
        updatedAt: "2026-11-19T10:30:00.000",
      }),
      run({
        runId: "run_bad",
        status: "failed",
        costCny: 0.5,
        updatedAt: "2026-11-19T10:00:00.000",
      }),
      run({
        runId: "it_1",
        status: "succeeded",
        costCny: 10,
        updatedAt: "2026-11-18T21:00:00.000",
      }),
    ];

    const split = splitWorldRuns(runs, metas, nowMs);

    expect(split.inProgress.map((item) => item.runId)).toEqual(["run_live"]);
    expect(split.needsYou.map((item) => item.runId)).toEqual([
      "run_wait",
      "run_bad",
    ]);
    expect(split.needsYou[0]?.waitReason).toBe("approval required");
    expect(split.startedToday).toHaveLength(4);
    expect(split.finishedToday.map((item) => item.runId)).toEqual([
      "run_ok",
      "run_bad",
    ]);
    expect(split.passRate).toBe(50);
    expect(split.spendToday).toBeCloseTo(6.5);
    expect(split.tokensToday).toBe(0);
    expect(split.artifactCountToday).toBe(7);
  });

  it("clamps progress into an integer percentage", () => {
    expect(progressPercent(run({ runId: "a", progress: 0.456 }))).toBe(46);
    expect(progressPercent(run({ runId: "b", progress: -1 }))).toBe(0);
    expect(progressPercent(run({ runId: "c", progress: 2 }))).toBe(100);
  });
});
