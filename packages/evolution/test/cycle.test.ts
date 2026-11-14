import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEvolutionCycle } from "../src/cycle";
import { verifyEvalSnapshot } from "../src/snapshot";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

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

async function runStubCycle(input: {
  root: string;
  packDir: string;
  inputFile: string;
  cyclesRoot: string;
  name: string;
  allowEvaluatorChange?: boolean;
  evaluatorApprovalRef?: string;
}) {
  const variantsRoot = path.join(input.root, input.name);
  return await runEvolutionCycle({
    packDir: input.packDir,
    agentId: "writer",
    inputFile: input.inputFile,
    stub: true,
    force: true,
    autoApply: false,
    cyclesRoot: input.cyclesRoot,
    variantsRoot,
    archivePath: path.join(variantsRoot, "archive.jsonl"),
    cyclesPath: path.join(variantsRoot, "cycles.jsonl"),
    statePath: path.join(variantsRoot, "state.json"),
    ...(input.allowEvaluatorChange ? { allowEvaluatorChange: true } : {}),
    ...(input.evaluatorApprovalRef
      ? { evaluatorApprovalRef: input.evaluatorApprovalRef }
      : {}),
  });
}

describe("evolution cycle", () => {
  it("runs signals → proposal → evaluation → canary in stub mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kit-cycle-"));
    roots.push(root);
    const cyclesRoot = path.join(root, "cycles");
    const variantsRoot = path.join(root, "variants");
    const archivePath = path.join(variantsRoot, "archive.jsonl");
    const cyclesPath = path.join(variantsRoot, "cycles.jsonl");
    const statePath = path.join(variantsRoot, "state.json");
    const inputFile = await writeEvidence(root);

    const record = await runStubCycle({
      root,
      packDir: path.join(process.cwd(), "packs", "tech-radar"),
      inputFile,
      cyclesRoot,
      name: "variants",
    });

    expect(record.decision).toBe("canary");
    expect(record.agentId).toBe("writer");
    expect(record.candidatePass).toBe(true);
    expect(record.baselineName).toContain("baseline");
    expect(record.candidateName).toContain("candidate");
    expect(record.evalSnapshotPath).toBeTruthy();
    expect(record.evalSnapshotHash).toBeTruthy();
    expect(record.evaluatorHash).toBeTruthy();
    expect(existsSync(cyclesPath)).toBe(true);
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(path.join(variantsRoot, "proposals"))).toBe(true);

    const verification = await verifyEvalSnapshot(
      record.evalSnapshotPath ?? "",
    );
    expect(verification.ok).toBe(true);
    expect(verification.manifestHash).toBe(record.evalSnapshotHash);
  }, 30_000);

  it("requires approval before using a changed evaluator", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kit-cycle-eval-"));
    roots.push(root);
    const cyclesRoot = path.join(root, "cycles");
    const inputFile = await writeEvidence(root);
    const packDir = path.join(root, "pack");
    await cp(path.join(process.cwd(), "packs", "tech-radar"), packDir, {
      recursive: true,
    });

    const first = await runStubCycle({
      root,
      packDir,
      inputFile,
      cyclesRoot,
      name: "variants-1",
    });
    expect(first.decision).toBe("canary");
    expect(first.evalSnapshotPath).toBeTruthy();

    const rubricPath = path.join(packDir, "evals", "rubrics.yaml");
    await writeFile(
      rubricPath,
      `${await readFile(rubricPath, "utf8")}\n# evaluator change\n`,
      "utf8",
    );

    const skipped = await runStubCycle({
      root,
      packDir,
      inputFile,
      cyclesRoot,
      name: "variants-2",
    });
    expect(skipped.decision).toBe("skipped");
    expect(skipped.rationale).toContain("evaluator changed");
    expect(existsSync(path.join(cyclesRoot, skipped.cycleId, "eval"))).toBe(
      false,
    );

    const approved = await runStubCycle({
      root,
      packDir,
      inputFile,
      cyclesRoot,
      name: "variants-3",
      allowEvaluatorChange: true,
      evaluatorApprovalRef: "test-approval",
    });
    expect(approved.decision).toBe("canary");
    expect(approved.evaluatorApprovalRef).toBe("test-approval");
    expect(approved.evalSnapshotPath).toBeTruthy();
    expect(approved.evaluatorHash).not.toBe(first.evaluatorHash);
  }, 60_000);
});
