import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type EvolutionCycleRecord,
  type EvolutionRecord,
  StoreEvolutionRepository,
  type VariantMeta,
} from "@kit/evolution";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-evolution-"));
  dirs.push(dir);
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
  return { dir, variantsRoot, store, repo };
}

async function makeVariant(
  variantsRoot: string,
  dirName: string,
  id: string,
  name: string,
): Promise<{ meta: VariantMeta; dir: string }> {
  const dir = path.join(variantsRoot, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "agent.md"), `# ${name}\n`, "utf8");
  const createdAt = new Date().toISOString();
  return {
    dir,
    meta: {
      id,
      name,
      parent: null,
      agentId: "docs",
      model: "stub",
      createdAt,
      baselineHashes: {},
      changedFiles: ["agent.md"],
    },
  };
}

describe("sqlite evolution repository", () => {
  it("round-trips variants, scores, cycles, state and locks", async () => {
    const { variantsRoot, repo } = await setup();
    const a = await makeVariant(variantsRoot, "variant-a", "var_a", "a");
    const b = await makeVariant(variantsRoot, "variant-b", "var_b", "b");
    await repo.saveVariant({ meta: a.meta, dir: a.dir, packDir: "pack-a" });
    await repo.saveVariant({ meta: b.meta, dir: b.dir, packDir: "pack-a" });

    const variants = await repo.listVariants("pack-a");
    expect(variants.map((variant) => variant.meta.id).sort()).toEqual([
      "var_a",
      "var_b",
    ]);
    const fetched = await repo.getVariant("var_a");
    expect(fetched?.meta.name).toBe("a");
    expect(fetched?.dir).toBe(path.resolve(a.dir));

    const score = (variantId: string, name: string, pass: boolean) =>
      ({
        variantId,
        name,
        parent: null,
        agentId: "docs",
        stub: true,
        createdAt: new Date().toISOString(),
        pass,
        scores: { quality: pass ? 0.9 : 0.4 },
        rationale: pass ? "good" : "weak",
        costCny: 0.01,
        tokens: 10,
        draftChars: 20,
      }) satisfies EvolutionRecord;
    await repo.appendScore(score("var_a", "a", true));
    await repo.appendScore(score("var_b", "b", false));

    const latest = await repo.latestScores();
    expect(latest).toHaveLength(2);
    expect(latest.find((record) => record.variantId === "var_a")?.pass).toBe(
      true,
    );
    expect(latest.find((record) => record.variantId === "var_b")?.pass).toBe(
      false,
    );

    const cycle: EvolutionCycleRecord = {
      cycleId: "cyc_1",
      packDir: "pack-a",
      agentId: "docs",
      hypothesis: "b is better",
      signals: ["quality"],
      baselineName: "a",
      candidateName: "b",
      baselinePass: true,
      candidatePass: false,
      baselineScore: 0.9,
      candidateScore: 0.4,
      costCny: 0.02,
      decision: "rejected",
      rationale: "candidate regressed",
      autoApplied: false,
      createdAt: new Date().toISOString(),
    };
    await repo.appendCycle(cycle);
    const cycles = await repo.listCycles(10);
    expect(cycles[0]?.cycleId).toBe("cyc_1");
    expect(cycles[0]?.candidatePass).toBe(false);
    expect(cycles[0]?.signals).toEqual(["quality"]);

    expect(await repo.setState({ champion: { path: a.dir } })).toBe(true);
    const state = await repo.getState();
    expect(state?.state.champion.path).toBe(path.resolve(a.dir));
    expect(state?.version).toBe(0);
    expect(
      await repo.setState({ champion: { path: a.dir } }, state?.version),
    ).toBe(true);

    expect(await repo.withLock("evolution-test", async () => 42)).toBe(42);
  }, 60_000);
});
