import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PublishedRun } from "@kit/publish";
import { afterEach, describe, expect, it } from "vitest";
import { assembleSite } from "../src/publish-site";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function sampleRun(runId: string, createdAt: string): PublishedRun {
  return {
    runId,
    title: `Run ${runId}`,
    summary: "Summary",
    workflowId: "wf",
    workspaceId: "default",
    status: "succeeded",
    runMode: "DRY_RUN",
    createdAt,
    updatedAt: createdAt,
    costCny: 0,
    tokens: 0,
    durationMs: 0,
    stages: [],
    artifacts: [],
  };
}

describe("assemble site", () => {
  it("accumulates runs and removes legacy files on first build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kit-site-test-"));
    roots.push(root);
    await writeFile(path.join(root, "art_legacy.html"), "old", "utf8");

    const options = {
      title: "Published runs",
      description: "Archive",
    };
    const first = await assembleSite(root, {
      run: sampleRun("run_1", "2026-11-14T00:00:00.000Z"),
      runFiles: {
        "runs/run_1/index.html": "first",
      },
      options,
      explicitTitle: false,
      explicitDescription: false,
    });

    expect(first.runs).toHaveLength(1);
    expect(
      await readFile(path.join(root, "runs/run_1/index.html"), "utf8"),
    ).toBe("first");
    await expect(
      readFile(path.join(root, "art_legacy.html"), "utf8"),
    ).rejects.toThrow();

    const second = await assembleSite(root, {
      run: sampleRun("run_2", "2026-11-15T00:00:00.000Z"),
      runFiles: {
        "runs/run_2/index.html": "second",
      },
      options,
      explicitTitle: false,
      explicitDescription: false,
    });

    expect(second.runs.map((run) => run.runId)).toEqual(["run_2", "run_1"]);
    const index = await readFile(path.join(root, "index.html"), "utf8");
    expect(index).toContain("Run run_1");
    expect(index).toContain("Run run_2");
    const stored = JSON.parse(
      await readFile(path.join(root, "site.json"), "utf8"),
    ) as { runs: Array<{ runId: string }> };
    expect(stored.runs).toHaveLength(2);
  });

  it("keeps an existing site title unless explicitly overridden", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kit-site-test-"));
    roots.push(root);
    await mkdir(path.join(root, "runs"), { recursive: true });
    await writeFile(
      path.join(root, "site.json"),
      JSON.stringify({
        version: 1,
        title: "Custom title",
        description: "Custom description",
        updatedAt: "2026-11-14T00:00:00.000Z",
        runs: [],
      }),
      "utf8",
    );

    const site = await assembleSite(root, {
      run: sampleRun("run_1", "2026-11-14T00:00:00.000Z"),
      runFiles: { "runs/run_1/index.html": "first" },
      options: { title: "Default", description: "Default" },
      explicitTitle: false,
      explicitDescription: false,
    });

    expect(site.title).toBe("Custom title");
    expect(site.description).toBe("Custom description");
  });
});
