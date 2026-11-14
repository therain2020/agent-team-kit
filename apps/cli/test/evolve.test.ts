import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  compareVariants,
  initVariant,
  proposeVariant,
  scoreVariant,
} from "@kit/evolution";
import { describe, expect, it } from "vitest";

const root = path.resolve(".tmp/evolve-test");

describe("evolution lab", () => {
  it("creates, scores and compares a variant", async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });

    const baselineDir = path.join(root, "baseline");
    const childDir = path.join(root, "child");
    const instructions = path.join(root, "writer-v2.md");
    const evidence = path.join(root, "evidence.json");
    const archive = path.join(root, "archive.jsonl");

    await writeFile(
      instructions,
      "You are writer v2. Cite evidence and include recommendations.",
      "utf8",
    );
    await writeFile(
      evidence,
      JSON.stringify({
        generatedAt: "2026-11-14T00:00:00.000Z",
        sources: [
          {
            citationId: "S1",
            title: "Example",
            url: "https://example.com",
          },
        ],
        errors: [],
      }),
      "utf8",
    );

    const base = await initVariant("packs/tech-radar", baselineDir, "baseline");
    expect(base.meta.parent).toBeNull();

    const child = await proposeVariant(
      baselineDir,
      "writer",
      instructions,
      childDir,
      "writer-v2",
      "deepseek-pro",
    );
    expect(child.meta.parent).toBe(base.meta.id);
    expect(child.meta.changedFiles).toEqual(["agents/writer.md"]);

    const record = await scoreVariant(
      childDir,
      "packs/tech-radar",
      evidence,
      "writer",
      { stub: true, archive },
    );
    expect(record.pass).toBe(true);
    expect(record.scores.deterministic).toBe(1);
    expect(record.costCny).toBe(0);

    const compared = await compareVariants(archive);
    expect(compared).toHaveLength(1);
    expect(compared[0]?.variantId).toBe(child.meta.id);

    await appendFile(
      path.join(childDir, "workflows", "daily-radar.yaml"),
      "\n# tampered\n",
      "utf8",
    );
    await expect(
      scoreVariant(childDir, "packs/tech-radar", evidence, "writer", {
        stub: true,
        archive,
      }),
    ).rejects.toThrow("locked file changed");
  });
});
