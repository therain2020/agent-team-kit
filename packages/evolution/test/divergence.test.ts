import { describe, expect, it } from "vitest";
import type { EvolutionCycleRecord } from "../src/cycle";
import {
  type DivergencePoint,
  buildDivergencePoints,
  divergenceGuard,
} from "../src/divergence";
import type { OutcomeObservation } from "../src/outcome";

function cycleRecord(
  cycleId: string,
  createdAt: string,
  baselineScore: number,
  candidateScore: number,
): EvolutionCycleRecord {
  return {
    cycleId,
    packDir: "packs/tech-radar",
    agentId: "writer",
    hypothesis: "cite every claim",
    signals: [],
    signalRefs: [],
    signalSources: [],
    baselineName: `cycle-${cycleId}-baseline`,
    candidateName: `cycle-${cycleId}-candidate`,
    baselinePass: true,
    candidatePass: true,
    baselineScore,
    candidateScore,
    costCny: 0,
    decision: "canary",
    rationale: "seeded",
    autoApplied: false,
    createdAt,
  };
}

function outcome(
  cycleId: string,
  at: string,
  score: number,
): OutcomeObservation {
  return {
    at,
    source: "human_review",
    score,
    pass: score >= 0.5,
    cycleId,
  };
}

describe("Goodhart divergence guard", () => {
  it("pauses after consecutive score-up/outcome-down cycles", () => {
    const points: DivergencePoint[] = [
      {
        cycleId: "cyc_1",
        createdAt: "2026-11-18T00:00:00.000Z",
        scoreDelta: 0.08,
        outcomeDelta: -0.1,
      },
      {
        cycleId: "cyc_2",
        createdAt: "2026-11-19T00:00:00.000Z",
        scoreDelta: 0.1,
        outcomeDelta: -0.2,
      },
    ];
    const result = divergenceGuard(points, { window: 2 });
    expect(result.divergent).toBe(true);
    expect(result.streak).toBe(2);
    expect(result.reasons).toHaveLength(2);
    expect(result.hint).toContain("Goodhart");
    expect(result.cycleIds).toEqual(["cyc_1", "cyc_2"]);
  });

  it("treats a flat outcome as divergence and a rising outcome as healthy", () => {
    const flat = divergenceGuard(
      [
        {
          cycleId: "cyc_1",
          createdAt: "2026-11-18T00:00:00.000Z",
          scoreDelta: 0.1,
          outcomeDelta: 0,
        },
      ],
      { window: 1 },
    );
    expect(flat.divergent).toBe(true);
    expect(flat.streak).toBe(1);

    const healthy = divergenceGuard(
      [
        {
          cycleId: "cyc_1",
          createdAt: "2026-11-18T00:00:00.000Z",
          scoreDelta: 0.1,
          outcomeDelta: 0.1,
        },
      ],
      { window: 1 },
    );
    expect(healthy.divergent).toBe(false);
    expect(healthy.streak).toBe(0);
  });

  it("pauses on one severe cycle even below the window", () => {
    const result = divergenceGuard(
      [
        {
          cycleId: "cyc_1",
          createdAt: "2026-11-18T00:00:00.000Z",
          scoreDelta: 0.2,
          outcomeDelta: -0.3,
        },
      ],
      { window: 3 },
    );
    expect(result.divergent).toBe(true);
    expect(result.severe).toBe(true);
    expect(result.reasons[0]).toContain("severe");
    expect(result.hint).toContain("baseline review");
  });

  it("resets the streak when an improvement is real", () => {
    const points: DivergencePoint[] = [
      {
        cycleId: "cyc_1",
        createdAt: "2026-11-18T00:00:00.000Z",
        scoreDelta: 0.08,
        outcomeDelta: -0.1,
      },
      {
        cycleId: "cyc_2",
        createdAt: "2026-11-19T00:00:00.000Z",
        scoreDelta: 0.08,
        outcomeDelta: 0.1,
      },
      {
        cycleId: "cyc_3",
        createdAt: "2026-11-20T00:00:00.000Z",
        scoreDelta: 0.08,
        outcomeDelta: -0.1,
      },
    ];
    const result = divergenceGuard(points, { window: 2 });
    expect(result.divergent).toBe(false);
    expect(result.streak).toBe(1);
  });

  it("joins outcomes onto scored cycles in chronological order", () => {
    const cycles = [
      cycleRecord("cyc_2", "2026-11-19T00:00:00.000Z", 0.6, 0.68),
      cycleRecord("cyc_1", "2026-11-18T00:00:00.000Z", 0.5, 0.6),
      cycleRecord("cyc_3", "2026-11-20T00:00:00.000Z", 0.6, 0.61),
    ];
    const outcomes = [
      outcome("cyc_1", "2026-11-18T01:00:00.000Z", 0.9),
      outcome("cyc_2", "2026-11-19T01:00:00.000Z", 0.4),
    ];
    const points = buildDivergencePoints(cycles, outcomes);
    expect(points.map((point) => point.cycleId)).toEqual(["cyc_1", "cyc_2"]);
    expect(points[0]?.scoreDelta).toBe(0.1);
    expect(points[0]?.outcomeDelta).toBe(0);
    expect(points[1]?.scoreDelta).toBe(0.08);
    expect(points[1]?.outcomeDelta).toBe(-0.5);
    // Unreviewed cycles never fabricate a flat outcome.
    expect(points.some((point) => point.cycleId === "cyc_3")).toBe(false);
  });
});
