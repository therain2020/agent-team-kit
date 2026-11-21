import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DriftBaseline,
  detectDrift,
  distributionShift,
  driftSummary,
  inputDistributionOf,
  modelPinFor,
  readDriftBaseline,
  writeDriftBaseline,
} from "../src/drift";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function baseline(overrides: Partial<DriftBaseline> = {}): DriftBaseline {
  return {
    modelPin: "deepseek-pro",
    inputDistribution: { ai: 6, chips: 4 },
    agreement: 0.9,
    sample: 10,
    updatedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("drift detection", () => {
  it("measures normalized distribution distance", () => {
    expect(distributionShift({ a: 5, b: 5 }, { a: 5, b: 5 })).toBe(0);
    expect(distributionShift(undefined, { a: 1 })).toBe(0);
    expect(distributionShift({}, { a: 1 })).toBe(0);
    expect(distributionShift({ a: 10 }, { b: 10 })).toBe(1);
    expect(distributionShift({ a: 8, b: 2 }, { a: 2, b: 8 })).toBeCloseTo(
      0.6,
      5,
    );
  });

  it("reports a model pin change as a full champion re-evaluation", () => {
    const report = detectDrift({
      previous: baseline(),
      current: baseline({ modelPin: "deepseek-pro@2027-01-01" }),
    });
    expect(report.drifted).toBe(true);
    expect(report.reevaluateChampion).toBe(true);
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "model_pin",
    ]);
    expect(report.reasons[0]).toContain("model pin changed");
  });

  it("alerts and re-evaluates when evaluator agreement drops below 0.8", () => {
    const report = detectDrift({
      previous: baseline(),
      current: baseline({ agreement: 0.6, sample: 10 }),
    });
    expect(report.drifted).toBe(true);
    expect(report.reevaluateChampion).toBe(true);
    expect(report.findings[0]?.kind).toBe("evaluator_agreement");
    expect(report.findings[0]?.detail).toContain("0.60");
    expect(report.findings[0]?.detail).toContain("10 reviews");
  });

  it("ignores a low agreement backed by too few reviews", () => {
    const report = detectDrift({
      previous: baseline(),
      current: baseline({ agreement: 0.2, sample: 2 }),
    });
    expect(report.drifted).toBe(false);
    expect(report.reevaluateChampion).toBe(false);
  });

  it("re-evaluates when the input distribution shifts", () => {
    const report = detectDrift({
      previous: baseline({ agreement: 0.9 }),
      current: baseline({
        inputDistribution: { ai: 1, chips: 9 },
        agreement: 0.9,
      }),
    });
    expect(report.drifted).toBe(true);
    expect(report.findings[0]?.kind).toBe("input_distribution");
    expect(report.findings[0]?.detail).toContain("TV 0.50");
  });

  it("is quiet when nothing moved and reports no first-cycle drift", () => {
    const stable = detectDrift({
      previous: baseline(),
      current: baseline(),
    });
    expect(stable.drifted).toBe(false);
    expect(stable.findings).toEqual([]);

    const first = detectDrift({
      previous: null,
      current: baseline(),
    });
    expect(first.drifted).toBe(false);
    expect(first.reevaluateChampion).toBe(false);
  });

  it("builds pins and input distributions from real inputs", () => {
    expect(modelPinFor("deepseek-pro")).toBe("deepseek-pro");
    expect(modelPinFor("deepseek-pro", "2026-11-01")).toBe(
      "deepseek-pro@2026-11-01",
    );
    const distribution = inputDistributionOf([
      { domain: "ai" },
      { domain: "ai" },
      { domain: "chips" },
    ] as unknown as Parameters<typeof inputDistributionOf>[0]);
    expect(distribution).toEqual({ ai: 2, chips: 1 });
  });

  it("round-trips the baseline file and tolerates corruption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kit-drift-"));
    roots.push(root);
    const file = path.join(root, "drift-baseline.json");

    expect(await readDriftBaseline(file)).toBeNull();
    await writeDriftBaseline(file, baseline({ agreement: null, sample: 0 }));
    const restored = await readDriftBaseline(file);
    expect(restored?.modelPin).toBe("deepseek-pro");
    expect(restored?.inputDistribution).toEqual({ ai: 6, chips: 4 });
    expect(restored?.agreement).toBeNull();

    const summary = driftSummary(
      detectDrift({
        previous: restored,
        current: baseline({ agreement: 0.5, sample: 8 }),
      }),
    );
    expect(summary.drifted).toBe(true);
    expect(summary.reevaluateChampion).toBe(true);
    expect(summary.agreement).toBe(0.5);
  });
});
