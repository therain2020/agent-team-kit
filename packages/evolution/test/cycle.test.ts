import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEvolutionCycle } from "../src/cycle";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("evolution cycle", () => {
  it("runs signals → proposal → evaluation → canary in stub mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kit-cycle-"));
    roots.push(root);
    const variantsRoot = path.join(root, "variants");
    const archivePath = path.join(variantsRoot, "archive.jsonl");
    const cyclesPath = path.join(variantsRoot, "cycles.jsonl");
    const statePath = path.join(variantsRoot, "state.json");
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

    const record = await runEvolutionCycle({
      packDir: path.join(process.cwd(), "packs", "tech-radar"),
      agentId: "writer",
      inputFile,
      stub: true,
      force: true,
      autoApply: false,
      variantsRoot,
      archivePath,
      cyclesPath,
      statePath,
    });

    expect(record.decision).toBe("canary");
    expect(record.agentId).toBe("writer");
    expect(record.candidatePass).toBe(true);
    expect(record.baselineName).toContain("baseline");
    expect(record.candidateName).toContain("candidate");
    expect(existsSync(cyclesPath)).toBe(true);
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(path.join(variantsRoot, "proposals"))).toBe(true);
  }, 30_000);
});
