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
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type EvolutionCycleRecord,
  loadEvolutionCycles,
  runEvolutionCycle,
} from "../src/cycle";
import {
  convergenceGuard,
  freezeEvolution,
  frozenRationale,
  loadFreezeState,
  unfreezeEvolution,
} from "../src/freeze";
import { StoreEvolutionRepository } from "../src/postgres";

// Count every model call so "frozen means zero model calls" is observable.
const modelCalls = vi.hoisted(() => ({ complete: 0 }));

vi.mock("@kit/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kit/model")>();
  return {
    ...actual,
    createModelGateway: () => ({
      complete: async () => {
        modelCalls.complete += 1;
        return {
          text: "Evolved instructions that cite every claim.",
          usage: { inputTokens: 500, outputTokens: 500, costCny: 5 },
        };
      },
      completeWithTools: async () => {
        throw new Error("tool completion is not used by evolution");
      },
    }),
  };
});

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
const originalModelMode = process.env.KIT_MODEL_MODE;

beforeEach(() => {
  process.env.KIT_MODEL_MODE = "live";
});

afterEach(async () => {
  if (originalModelMode === undefined) {
    Reflect.deleteProperty(process.env, "KIT_MODEL_MODE");
  } else {
    process.env.KIT_MODEL_MODE = originalModelMode;
  }
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kit-freeze-"));
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

function cycleRecord(
  cycleId: string,
  decision: EvolutionCycleRecord["decision"],
  createdAt: string,
): EvolutionCycleRecord {
  return {
    cycleId,
    packDir: "packs/tech-radar",
    agentId: "writer",
    hypothesis: "try a new writer instruction set",
    signals: ["writer failed the citation check"],
    signalRefs: [],
    signalSources: [],
    baselineName: `cycle-${cycleId}-baseline`,
    candidateName: `cycle-${cycleId}-candidate`,
    baselinePass: true,
    candidatePass: decision !== "rejected",
    baselineScore: 0.7,
    candidateScore: 0.71,
    costCny: 0.01,
    decision,
    rationale: "seeded cycle",
    autoApplied: false,
    createdAt,
  };
}

describe("evolution freeze", () => {
  it("skips a frozen workspace with zero model calls and zero writes", async () => {
    const root = await makeRoot();
    const variantsRoot = path.join(root, "variants");
    const freezePath = path.join(variantsRoot, "freeze.json");
    const cyclesPath = path.join(variantsRoot, "cycles.jsonl");
    const statePath = path.join(variantsRoot, "state.json");
    const archivePath = path.join(variantsRoot, "archive.jsonl");

    await freezeEvolution(
      {
        kind: "incident",
        reason: "sev1 checkout outage",
        actor: "operator:test",
      },
      { freezePath },
    );

    const callsBefore = modelCalls.complete;
    const record = await runEvolutionCycle({
      packDir: path.join(process.cwd(), "packs", "tech-radar"),
      agentId: "writer",
      // Deliberately missing: a frozen cycle must stop before reading it.
      inputFile: path.join(root, "missing-evidence.json"),
      stub: false,
      force: true,
      variantsRoot,
      archivePath,
      cyclesPath,
      statePath,
      freezePath,
      cyclesRoot: path.join(root, "cycles"),
    });

    expect(record.decision).toBe("skipped");
    expect(record.rationale).toContain("evolution is frozen (incident)");
    expect(record.rationale).toContain("sev1 checkout outage");
    expect(modelCalls.complete).toBe(callsBefore);
    expect(existsSync(archivePath)).toBe(false);
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(path.join(variantsRoot, "proposals"))).toBe(false);
    const entries = await readdir(variantsRoot, { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory())).toEqual([]);

    const persisted = await loadEvolutionCycles(cyclesPath, 10);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.decision).toBe("skipped");

    const lifted = await unfreezeEvolution(
      { reason: "incident closed", actor: "operator:test" },
      { freezePath },
    );
    expect(lifted.status).toBe("active");
    expect((await loadFreezeState({ freezePath })).status).toBe("active");
  }, 30_000);

  it("auto-freezes after three consecutive cycles without improvement", async () => {
    const root = await makeRoot();
    const variantsRoot = path.join(root, "variants");
    const freezePath = path.join(variantsRoot, "freeze.json");
    const cyclesPath = path.join(variantsRoot, "cycles.jsonl");
    await mkdir(variantsRoot, { recursive: true });
    const seeded = [
      "2026-11-17T00:00:00.000Z",
      "2026-11-18T00:00:00.000Z",
      "2026-11-19T00:00:00.000Z",
    ].map((createdAt, index) =>
      cycleRecord(`cyc_seed_${index}`, "rejected", createdAt),
    );
    await writeFile(
      cyclesPath,
      seeded.map((record) => `${JSON.stringify(record)}\n`).join(""),
      "utf8",
    );

    const callsBefore = modelCalls.complete;
    const record = await runEvolutionCycle({
      packDir: path.join(process.cwd(), "packs", "tech-radar"),
      agentId: "writer",
      inputFile: await writeEvidence(root),
      stub: false,
      force: true,
      variantsRoot,
      archivePath: path.join(variantsRoot, "archive.jsonl"),
      cyclesPath,
      statePath: path.join(variantsRoot, "state.json"),
      freezePath,
      cyclesRoot: path.join(root, "cycles"),
    });

    expect(record.decision).toBe("skipped");
    expect(record.rationale).toContain("evolution is frozen (convergence)");
    expect(record.rationale).toContain("no significant improvement");
    expect(modelCalls.complete).toBe(callsBefore);

    const freeze = await loadFreezeState({ freezePath });
    expect(freeze.status).toBe("frozen");
    expect(freeze.kind).toBe("convergence");
    expect(freeze.reason).toContain("no significant improvement");
    expect(freeze.liftCondition).toContain("retrospective");
    expect(frozenRationale(freeze)).toContain("lift:");
  }, 30_000);

  it("records a budget overrun and stops before writing variants", async () => {
    const root = await makeRoot();
    const variantsRoot = path.join(root, "variants");
    const cyclesPath = path.join(variantsRoot, "cycles.jsonl");
    const callsBefore = modelCalls.complete;

    const record = await runEvolutionCycle({
      packDir: path.join(process.cwd(), "packs", "tech-radar"),
      agentId: "writer",
      inputFile: await writeEvidence(root),
      stub: false,
      force: true,
      budgetCny: 1,
      variantsRoot,
      archivePath: path.join(variantsRoot, "archive.jsonl"),
      cyclesPath,
      statePath: path.join(variantsRoot, "state.json"),
      freezePath: path.join(variantsRoot, "freeze.json"),
      cyclesRoot: path.join(root, "cycles"),
    });

    expect(record.decision).toBe("skipped");
    expect(record.rationale).toContain("cycle budget exceeded");
    expect(record.rationale).toContain("of 1 CNY");
    expect(record.costCny).toBe(5);
    expect(modelCalls.complete).toBe(callsBefore + 1);
    expect(existsSync(path.join(variantsRoot, "proposals"))).toBe(false);
    const entries = await readFile(cyclesPath, "utf8");
    expect(entries).toContain('"decision":"skipped"');
  }, 30_000);

  it("persists freeze state through the sqlite repository", async () => {
    const dir = await makeRoot();
    const variantsRoot = path.join(dir, "variants");
    const store = await initStore(
      loadStoreConfig({
        KIT_RUNTIME_MODE: "local",
        KIT_HOME: dir,
        KIT_BLOB_ROOT: path.join(dir, "blobs"),
      }),
    );
    closers.push(() => store.close());
    const repo = new StoreEvolutionRepository(store, {
      variantsRoot,
      archivePath: path.join(variantsRoot, "archive.jsonl"),
      cyclesPath: path.join(variantsRoot, "cycles.jsonl"),
      statePath: path.join(variantsRoot, "state.json"),
    });

    expect(await repo.getFreeze()).toBeNull();
    const frozen = await freezeEvolution(
      {
        kind: "divergence",
        reason: "scores up, outcomes down",
        actor: "operator:test",
      },
      { repo },
    );
    expect(frozen.status).toBe("frozen");

    const stored = await repo.getFreeze();
    expect(stored?.status).toBe("frozen");
    expect(stored?.kind).toBe("divergence");
    expect(stored?.reason).toBe("scores up, outcomes down");
    expect(stored?.liftCondition).toContain("evaluation baseline");

    const lifted = await unfreezeEvolution(
      { reason: "baseline restored", actor: "operator:test" },
      { repo },
    );
    expect(lifted.status).toBe("active");
    const cleared = await repo.getFreeze();
    expect(cleared?.status).toBe("active");
    expect(cleared?.liftReason).toBe("baseline restored");
  }, 60_000);
});

describe("convergence guard", () => {
  it("counts trailing attempts and ignores skipped cycles", () => {
    const cycles = [
      cycleRecord("cyc_1", "canary", "2026-11-17T00:00:00.000Z"),
      cycleRecord("cyc_2", "skipped", "2026-11-17T01:00:00.000Z"),
      cycleRecord("cyc_3", "rejected", "2026-11-18T00:00:00.000Z"),
      cycleRecord("cyc_4", "rejected", "2026-11-19T00:00:00.000Z"),
    ];
    expect(convergenceGuard(cycles, 3).streak).toBe(2);
    expect(convergenceGuard(cycles, 3).frozen).toBe(false);
    const three = [
      ...cycles,
      cycleRecord("cyc_5", "failed", "2026-11-20T00:00:00.000Z"),
    ];
    const guard = convergenceGuard(three, 3);
    expect(guard.streak).toBe(3);
    expect(guard.frozen).toBe(true);
    expect(guard.hint).toContain("retrospective");
  });
});
