import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type EvolutionCycleRecord, runEvolutionCycle } from "../src/cycle";
import { loadFreezeState } from "../src/freeze";
import { loadGovernanceEvents } from "../src/governance";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function cycleRecord(input: {
  cycleId: string;
  createdAt: string;
  baselineScore: number;
  candidateScore: number;
  candidatePass?: boolean;
}): EvolutionCycleRecord {
  return {
    cycleId: input.cycleId,
    packDir: "packs/tech-radar",
    agentId: "writer",
    hypothesis: "cite every claim",
    signals: [],
    signalRefs: [],
    signalSources: [],
    baselineName: `cycle-${input.cycleId}-baseline`,
    candidateName: `cycle-${input.cycleId}-candidate`,
    baselinePass: true,
    candidatePass: input.candidatePass ?? true,
    baselineScore: input.baselineScore,
    candidateScore: input.candidateScore,
    costCny: 0,
    decision: "canary",
    rationale: "seeded cycle",
    autoApplied: false,
    createdAt: input.createdAt,
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kit-goodhart-"));
  roots.push(root);
  return root;
}

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

function pathsFor(root: string) {
  const variantsRoot = path.join(root, "variants");
  return {
    variantsRoot,
    archivePath: path.join(variantsRoot, "archive.jsonl"),
    cyclesPath: path.join(variantsRoot, "cycles.jsonl"),
    statePath: path.join(variantsRoot, "state.json"),
    freezePath: path.join(variantsRoot, "freeze.json"),
    outcomesPath: path.join(root, "outcomes.jsonl"),
    governancePath: path.join(variantsRoot, "governance.jsonl"),
    driftBaselinePath: path.join(variantsRoot, "drift-baseline.json"),
    cyclesRoot: path.join(root, "cycles"),
  };
}

async function seedCycles(
  cyclesPath: string,
  cycles: EvolutionCycleRecord[],
): Promise<void> {
  await mkdir(path.dirname(cyclesPath), { recursive: true });
  await writeFile(
    cyclesPath,
    cycles.map((cycle) => `${JSON.stringify(cycle)}\n`).join(""),
    "utf8",
  );
}

describe("Goodhart and drift guards inside a cycle", () => {
  it("pauses a score-up/outcome-down cycle before any spend", async () => {
    const root = await makeRoot();
    const paths = pathsFor(root);
    await seedCycles(paths.cyclesPath, [
      cycleRecord({
        cycleId: "cyc_a",
        createdAt: "2026-11-18T00:00:00.000Z",
        baselineScore: 0.6,
        candidateScore: 0.66,
      }),
      cycleRecord({
        cycleId: "cyc_b",
        createdAt: "2026-11-19T00:00:00.000Z",
        baselineScore: 0.66,
        candidateScore: 0.72,
      }),
    ]);
    await writeFile(
      paths.outcomesPath,
      [
        JSON.stringify({
          at: "2026-11-18T01:00:00.000Z",
          source: "human_review",
          score: 0.9,
          pass: true,
          cycleId: "cyc_a",
        }),
        JSON.stringify({
          at: "2026-11-19T01:00:00.000Z",
          source: "human_review",
          score: 0.4,
          pass: false,
          cycleId: "cyc_b",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const record = await runEvolutionCycle({
      packDir: path.join(process.cwd(), "packs", "tech-radar"),
      agentId: "writer",
      // Deliberately missing: a divergence pause must happen before the input
      // file is read and before any model call or variant write.
      inputFile: path.join(root, "missing-evidence.json"),
      stub: true,
      force: true,
      ...paths,
      divergenceWindow: 2,
    });

    expect(record.decision).toBe("skipped");
    expect(record.rationale).toContain("evolution is frozen (divergence)");
    expect(record.divergence?.divergent).toBe(true);
    expect(record.divergence?.streak).toBe(2);

    const freeze = await loadFreezeState({ freezePath: paths.freezePath });
    expect(freeze.status).toBe("frozen");
    expect(freeze.kind).toBe("divergence");
    expect(freeze.reason).toContain("Goodhart");

    const events = await loadGovernanceEvents(paths.governancePath);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("divergence");
    expect(events[0]?.action).toBe("paused");
    expect(events[0]?.cycleIds).toEqual(["cyc_a", "cyc_b"]);

    expect(existsSync(paths.statePath)).toBe(false);
    expect(existsSync(paths.archivePath)).toBe(false);
    const entries = existsSync(paths.variantsRoot)
      ? await readdir(paths.variantsRoot, { withFileTypes: true })
      : [];
    expect(entries.filter((entry) => entry.isDirectory())).toEqual([]);
  }, 30_000);

  it("re-evaluates the champion when the provider pin changes", async () => {
    const root = await makeRoot();
    const paths = pathsFor(root);
    await mkdir(paths.variantsRoot, { recursive: true });
    await writeFile(
      paths.driftBaselinePath,
      JSON.stringify({
        modelPin: "deepseek-pro@2026-11-01",
        inputDistribution: {},
        agreement: null,
        sample: 0,
      }),
      "utf8",
    );

    const record = await runEvolutionCycle({
      packDir: path.join(process.cwd(), "packs", "tech-radar"),
      agentId: "writer",
      inputFile: await writeEvidence(root),
      stub: true,
      force: true,
      ...paths,
      modelPin: "deepseek-pro",
    });

    expect(record.decision).toBe("canary");
    expect(record.drift?.drifted).toBe(true);
    expect(record.drift?.reevaluateChampion).toBe(true);
    expect(record.drift?.findings[0]?.kind).toBe("model_pin");
    expect(record.drift?.reasons[0]).toContain("model pin changed");

    const events = await loadGovernanceEvents(paths.governancePath);
    expect(events[0]?.kind).toBe("drift");
    expect(events[0]?.action).toBe("reevaluate");

    const baseline = JSON.parse(
      await readFile(paths.driftBaselinePath, "utf8"),
    ) as { modelPin?: string };
    expect(baseline.modelPin).toBe("deepseek-pro");
  }, 30_000);

  it("records an alert when evaluator-human agreement falls below 0.8", async () => {
    const root = await makeRoot();
    const paths = pathsFor(root);
    const cycles = Array.from({ length: 6 }, (_, index) =>
      cycleRecord({
        cycleId: `cyc_${index}`,
        createdAt: `2026-11-2${index}T00:00:00.000Z`,
        // Slightly worse scores: no divergence, only agreement drift.
        baselineScore: 0.7,
        candidateScore: 0.69,
      }),
    );
    await seedCycles(paths.cyclesPath, cycles);
    await writeFile(
      paths.outcomesPath,
      cycles
        .map((cycle, index) =>
          JSON.stringify({
            at: cycle.createdAt,
            source: "human_review",
            score: index < 3 ? 0.8 : 0.3,
            pass: index >= 3,
            cycleId: cycle.cycleId,
          }),
        )
        .join("\n"),
      "utf8",
    );
    await mkdir(paths.variantsRoot, { recursive: true });
    await writeFile(
      paths.driftBaselinePath,
      JSON.stringify({
        modelPin: "deepseek-pro",
        inputDistribution: {},
        agreement: 0.9,
        sample: 6,
      }),
      "utf8",
    );

    const record = await runEvolutionCycle({
      packDir: path.join(process.cwd(), "packs", "tech-radar"),
      agentId: "writer",
      inputFile: await writeEvidence(root),
      stub: true,
      force: true,
      iterationsPath: path.join(root, "missing-iterations.jsonl"),
      ...paths,
      modelPin: "deepseek-pro",
    });

    expect(record.decision).toBe("canary");
    const findings = record.drift?.findings ?? [];
    expect(findings.map((finding) => finding.kind)).toContain(
      "evaluator_agreement",
    );
    expect(record.drift?.reevaluateChampion).toBe(true);

    const events = await loadGovernanceEvents(paths.governancePath);
    const agreementEvent = events.find((event) =>
      event.reason.includes("evaluator-human agreement"),
    );
    expect(agreementEvent?.kind).toBe("drift");
    expect(agreementEvent?.details?.agreement).toBe(0.5);
  }, 30_000);
});
