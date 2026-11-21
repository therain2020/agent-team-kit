import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeChangeRollback } from "@kit/change/rollback";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvolutionCycle } from "../src/cycle";

/**
 * 85 §3.5.6: an auto-applied evolution cycle persists a `cycle.promote`
 * ChangeProposal whose structured revert restores the original instructions
 * through the unified changeId rollback.
 */

// The judge prompt is fixed; the preceding draft call tells us which variant is
// being scored. Candidate (the evolved instructions) scores high, baseline low.
const modelState = vi.hoisted(() => ({ current: "baseline" as string }));

vi.mock("@kit/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kit/model")>();
  return {
    ...actual,
    createModelGateway: () => ({
      complete: async (input: unknown) => {
        const instructions =
          (input as { instructions?: string }).instructions ?? "";
        if (instructions.includes("independent quality evaluator")) {
          const high = modelState.current === "candidate";
          return {
            text: JSON.stringify({
              scores: {
                factuality: high ? 1 : 0.1,
                citations: high ? 1 : 0.1,
                coverage: high ? 1 : 0.1,
                structure: high ? 1 : 0.1,
                actionability: high ? 1 : 0.1,
              },
              rationale: high ? "strong" : "weak",
            }),
            usage: { inputTokens: 10, outputTokens: 10, costCny: 0.0001 },
          };
        }
        modelState.current = instructions.includes("Evolved")
          ? "candidate"
          : "baseline";
        return {
          text: "Evolved instructions that cite every claim [S1].",
          usage: { inputTokens: 10, outputTokens: 10, costCny: 0.0001 },
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
  modelState.current = "baseline";
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

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kit-cycle-promotion-"));
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

describe("evolution auto-promotion records cycle.promote", () => {
  it("promotes into a rollbackable proposal and restores instructions by changeId", async () => {
    const root = await tempRoot();
    const packDir = path.join(root, "pack");
    await cp(path.join(process.cwd(), "packs", "tech-radar"), packDir, {
      recursive: true,
    });
    const originalInstructions = await readFile(
      path.join(packDir, "agents", "writer.md"),
      "utf8",
    );
    const inputFile = await writeEvidence(root);
    const variantsRoot = path.join(root, "variants");

    const storeDir = await tempRoot();
    const store = await initStore(
      loadStoreConfig({
        KIT_RUNTIME_MODE: "local",
        KIT_HOME: storeDir,
        KIT_BLOB_ROOT: path.join(storeDir, "blobs"),
      }),
    );
    closers.push(() => store.close());

    const record = await runEvolutionCycle({
      packDir,
      cycleId: "cyc_1",
      agentId: "writer",
      inputFile,
      stub: false,
      force: true,
      autoApply: true,
      cyclesRoot: path.join(root, "cycles"),
      variantsRoot,
      archivePath: path.join(variantsRoot, "archive.jsonl"),
      cyclesPath: path.join(variantsRoot, "cycles.jsonl"),
      statePath: path.join(variantsRoot, "state.json"),
      changes: store.changeProposals,
    });

    expect(record.decision).toBe("promoted");
    expect(record.autoApplied).toBe(true);
    expect(record.changeId).toBe("chg_cy_default_cyc_1");
    expect(record.promote?.targetDir).toBe(packDir);
    expect(record.promote?.files).toEqual(["agents/writer.md"]);

    const proposal = await store.changeProposals.get(record.changeId ?? "");
    expect(proposal?.state).toBe("promoted");
    expect(proposal?.revert?.kind).toBe("instruction");

    const auditPath = path.join(root, "audit.jsonl");
    const result = await executeChangeRollback(
      { proposals: store.changeProposals, repoRoot: packDir, auditPath },
      {
        changeId: proposal?.id ?? "",
        actor: "kitd:operator",
        dryRun: false,
      },
    );

    expect(result.status).toBe("ok");
    expect(
      await readFile(path.join(packDir, "agents", "writer.md"), "utf8"),
    ).toBe(originalInstructions);
  });
});
