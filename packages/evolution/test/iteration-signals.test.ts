import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEvolutionCycle } from "../src/cycle";
import { type IterationSignal, readIterationSignals } from "../src/signals";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function signal(overrides: Partial<IterationSignal> = {}): IterationSignal {
  return {
    at: "2026-11-18T00:00:00.000Z",
    iterationId: "it_1",
    taskId: "task-a",
    domain: "cyber",
    coder: "shin",
    verified: false,
    applied: false,
    risk: "medium",
    tokens: 1200,
    ...overrides,
  };
}

async function writeSignals(
  root: string,
  lines: Array<IterationSignal | string>,
): Promise<string> {
  const file = path.join(root, "iterations.jsonl");
  await writeFile(
    file,
    `${lines
      .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
      .join("\n")}\n`,
    "utf8",
  );
  return file;
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

describe("iteration signal adapter", () => {
  it("returns no signals for a missing or empty file", async () => {
    const root = await tempRoot("kit-signals-empty-");
    const missing = await readIterationSignals(
      path.join(root, "iterations.jsonl"),
    );
    expect(missing.signals).toEqual([]);
    expect(missing.lines).toBe(0);

    const file = await writeSignals(root, []);
    const empty = await readIterationSignals(file);
    expect(empty.signals).toEqual([]);
    expect(empty.corrupt).toBe(0);
  });

  it("skips corrupt and structurally invalid lines", async () => {
    const root = await tempRoot("kit-signals-corrupt-");
    const file = await writeSignals(root, [
      signal(),
      "{not json",
      "",
      JSON.stringify({ iterationId: "it_2" }),
      JSON.stringify({ ...signal({ taskId: "task-b" }), verified: "no" }),
    ]);
    const result = await readIterationSignals(file);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.taskId).toBe("task-a");
    expect(result.lines).toBe(4);
    expect(result.corrupt).toBe(3);
  });

  it("collapses duplicates on the first occurrence", async () => {
    const root = await tempRoot("kit-signals-dup-");
    const file = await writeSignals(root, [
      signal(),
      signal({ tokens: 9999 }),
      signal({ taskId: "task-b" }),
    ]);
    const result = await readIterationSignals(file);
    expect(result.signals).toHaveLength(2);
    expect(result.signals[0]?.tokens).toBe(1200);
    expect(result.duplicates).toBe(1);
  });
});

describe("evolution cycle signal sources", () => {
  it("starts from failed iteration signals without --force", async () => {
    const root = await tempRoot("kit-cycle-iter-");
    const variantsRoot = path.join(root, "variants");
    const iterationsPath = await writeSignals(root, [
      signal(),
      signal({ taskId: "task-b", verified: true }),
    ]);
    const record = await runEvolutionCycle({
      packDir: path.join(process.cwd(), "packs", "tech-radar"),
      agentId: "writer",
      inputFile: await writeEvidence(root),
      stub: true,
      cyclesRoot: path.join(root, "cycles"),
      variantsRoot,
      iterationsPath,
      archivePath: path.join(variantsRoot, "archive.jsonl"),
      cyclesPath: path.join(variantsRoot, "cycles.jsonl"),
      statePath: path.join(variantsRoot, "state.json"),
    });

    expect(record.decision).toBe("canary");
    expect(record.signalRefs).toHaveLength(1);
    expect(record.signalRefs[0]).toMatchObject({
      source: "iterations",
      iterationId: "it_1",
      taskId: "task-a",
      domain: "cyber",
    });
    expect(record.signalRefs[0]?.signalId).toMatch(/^sig_/);
    expect(record.signalSources).toEqual([`iterations:${iterationsPath}`]);
    expect(record.hypothesis).toContain("iterations.jsonl");
    expect(record.hypothesis).toContain("it_1/task-a");
  }, 30_000);

  it("stays skipped with an empty file and no --force", async () => {
    const root = await tempRoot("kit-cycle-iter-skip-");
    const variantsRoot = path.join(root, "variants");
    const iterationsPath = await writeSignals(root, []);
    const record = await runEvolutionCycle({
      packDir: path.join(process.cwd(), "packs", "tech-radar"),
      agentId: "writer",
      inputFile: await writeEvidence(root),
      stub: true,
      force: false,
      cyclesRoot: path.join(root, "cycles"),
      variantsRoot,
      iterationsPath,
      archivePath: path.join(variantsRoot, "archive.jsonl"),
      cyclesPath: path.join(variantsRoot, "cycles.jsonl"),
      statePath: path.join(variantsRoot, "state.json"),
    });

    expect(record.decision).toBe("skipped");
    expect(record.rationale).toContain("no failure signals");
    expect(record.signalRefs).toEqual([]);
    expect(record.signalSources).toEqual([]);
  }, 30_000);
});
