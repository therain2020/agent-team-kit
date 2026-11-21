import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvolutionCycleRecord } from "../src/cycle";
import {
  attachOutcomes,
  defaultOutcomesPath,
  evaluatorAgreement,
  latestOutcomeForCycle,
  readOutcomeObservations,
  recordOutcome,
  summarizeOutcomes,
} from "../src/outcome";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function cycleRecord(
  cycleId: string,
  createdAt: string,
  candidatePass: boolean,
  baselineScore = 0.7,
  candidateScore = 0.72,
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
    candidatePass,
    baselineScore,
    candidateScore,
    costCny: 0,
    decision: "canary",
    rationale: "seeded",
    autoApplied: false,
    createdAt,
  };
}

describe("outcome observations", () => {
  it("reads defensively and collapses duplicates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kit-outcome-"));
    roots.push(root);
    const file = path.join(root, "outcomes.jsonl");
    const valid = {
      at: "2026-11-20T00:00:00.000Z",
      source: "human_review",
      score: 0.8,
      pass: true,
      cycleId: "cyc_1",
    };
    await writeFile(
      file,
      [
        JSON.stringify(valid),
        JSON.stringify(valid),
        "{not json",
        JSON.stringify({ ...valid, score: 1.4 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const parsed = await readOutcomeObservations(file);
    expect(parsed.outcomes).toHaveLength(1);
    expect(parsed.duplicates).toBe(1);
    expect(parsed.corrupt).toBe(2);
    expect(parsed.outcomes[0]?.score).toBe(0.8);
  });

  it("records a normalized observation and validates input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kit-outcome-"));
    roots.push(root);
    const file = path.join(root, "outcomes.jsonl");

    await expect(
      recordOutcome({ score: 1.2, pass: true, cycleId: "cyc_1" }, file),
    ).rejects.toThrow("between 0 and 1");
    await expect(
      recordOutcome({ score: 0.5, pass: true }, file),
    ).rejects.toThrow("cycleId or a variantId");

    const recorded = await recordOutcome(
      {
        score: 0.42,
        pass: false,
        cycleId: "cyc_1",
        source: "artifact_acceptance",
        ref: "artifact:123",
      },
      file,
    );
    expect(recorded.score).toBe(0.42);
    expect(recorded.pass).toBe(false);
    expect(recorded.source).toBe("artifact_acceptance");
    expect(defaultOutcomesPath(root)).toBe(path.join(root, "outcomes.jsonl"));

    const parsed = await readOutcomeObservations(file);
    expect(parsed.outcomes).toHaveLength(1);
    expect(parsed.outcomes[0]?.ref).toBe("artifact:123");
  });

  it("summarizes pass rate, average score and page out per cycle", () => {
    const outcomes = [
      {
        at: "2026-11-20T00:00:00.000Z",
        source: "human_review" as const,
        score: 0.9,
        pass: true,
        cycleId: "cyc_1",
      },
      {
        at: "2026-11-21T00:00:00.000Z",
        source: "artifact_acceptance" as const,
        score: 0.4,
        pass: false,
        cycleId: "cyc_2",
      },
    ];
    const summary = summarizeOutcomes(outcomes);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.passRate).toBe(0.5);
    expect(summary.avgScore).toBe(0.65);
    expect(summary.sources.human_review).toBe(1);

    const cycles = [
      cycleRecord("cyc_1", "2026-11-20T00:00:00.000Z", true),
      cycleRecord("cyc_2", "2026-11-21T00:00:00.000Z", true),
      cycleRecord("cyc_3", "2026-11-22T00:00:00.000Z", true),
    ];
    const joined = attachOutcomes(cycles, outcomes);
    expect(joined).toHaveLength(3);
    expect(joined[0]?.outcome?.pass).toBe(true);
    expect(joined[1]?.outcome?.pass).toBe(false);
    expect(joined[2]?.outcome).toBeNull();
    expect(latestOutcomeForCycle(outcomes, "cyc_2")?.score).toBe(0.4);
  });

  it("reports evaluator-human agreement only after enough reviews", () => {
    const cycles = Array.from({ length: 6 }, (_, index) =>
      cycleRecord(`cyc_${index}`, `2026-11-2${index}T00:00:00.000Z`, true),
    );
    const outcomes = cycles.map((cycle, index) => ({
      at: cycle.createdAt,
      source: "human_review" as const,
      score: index < 3 ? 0.9 : 0.3,
      // 3 agree with the evaluator, 3 disagree.
      pass: index >= 3,
      cycleId: cycle.cycleId,
    }));

    const agreement = evaluatorAgreement(cycles, outcomes);
    expect(agreement.sample).toBe(6);
    expect(agreement.agree).toBe(3);
    expect(agreement.rate).toBe(0.5);

    const smallSample = evaluatorAgreement(cycles.slice(0, 2), outcomes, 5);
    expect(smallSample.sample).toBe(2);
    expect(smallSample.rate).toBeNull();

    const empty = evaluatorAgreement(cycles, [], 5);
    expect(empty.rate).toBeNull();
  });
});
