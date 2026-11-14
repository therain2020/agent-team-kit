import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type EvolutionRecord,
  canaryStatus,
  decideRollback,
  evaluateCanary,
  initVariant,
  proposeVariant,
  rollbackCanary,
  startCanary,
} from "@kit/evolution";
import { describe, expect, it } from "vitest";

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
    createdAt: "2026-11-14T00:00:00.000Z",
    pass,
    scores: { quality: score },
    rationale: "",
    costCny,
    tokens: 0,
    draftChars: 100,
  };
}

describe("canary", () => {
  it("evaluates with stub and rolls back on regression", async () => {
    const root = path.resolve(".tmp/canary-test");
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });

    const baselineDir = path.join(root, "baseline");
    const canaryDir = path.join(root, "canary");
    const instructions = path.join(root, "writer.md");
    const evidence = path.join(root, "evidence.json");
    const archive = path.join(root, "archive.jsonl");
    const statePath = path.join(root, "state.json");

    await writeFile(instructions, "Write with citations.", "utf8");
    await writeFile(
      evidence,
      JSON.stringify({ sources: [{ citationId: "S1" }], errors: [] }),
      "utf8",
    );

    await initVariant("packs/tech-radar", baselineDir, "baseline");
    await proposeVariant(
      baselineDir,
      "writer",
      instructions,
      canaryDir,
      "canary",
    );

    const state = await startCanary(baselineDir, canaryDir, 20, statePath);
    expect(state.canary?.status).toBe("active");

    const evaluation = await evaluateCanary([evidence], {
      stub: true,
      archive,
      statePath,
    });
    expect(evaluation.decision.rollback).toBe(false);

    const decision = decideRollback(
      [record(true, 0.9, 0.05)],
      [record(false, 0.3, 0.08)],
    );
    expect(decision.rollback).toBe(true);

    await rollbackCanary("test", statePath);
    expect((await canaryStatus(statePath))?.canary?.status).toBe("rolled_back");
  });
});
