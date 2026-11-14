import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadPack } from "../src/load-pack";
import { buildPackRun } from "../src/pack-run";
import { setStagePositions } from "../src/pack-studio";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writePack(dir: string, stages: string): Promise<void> {
  dirs.push(dir);
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await mkdir(path.join(dir, "workflows"), { recursive: true });
  await writeFile(
    path.join(dir, "agents", "echo.md"),
    `---
name: echo
description: Minimal agent
model: deepseek-flash
tools: []
skills: []
---

Echo.
`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "team.yaml"),
    `apiVersion: agentteam/v1
kind: TeamPack
metadata:
  name: dag-demo
  version: 1.0.0
  compatibility:
    kit: ">=0.1 <2.0"
agents:
  - id: echo
    file: agents/echo.md
    model: deepseek-flash
    tools: []
    skills: []
workflows:
  - workflows/dag.yaml
policies: []
`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "workflows", "dag.yaml"),
    `id: dag-demo
version: 1.0
trigger:
  event: demo.requested
stages:
${stages}`,
    "utf8",
  );
}

const DAG_STAGES = `  - id: research
    type: agent
    agent: echo
    inputs: [request]
    outputs: [notes]
  - id: write
    type: agent
    agent: echo
    inputs: [notes]
    outputs: [draft]
    inputsFrom: [research]
  - id: review
    type: agent
    agent: echo
    inputs: [notes]
    outputs: [review]
    inputsFrom: [research]
    position: {x: 40, y: 160}
  - id: publish
    type: agent
    agent: echo
    inputs: [draft, review]
    outputs: [final]
    inputsFrom: [write, review]
`;

describe("workflow DAG", () => {
  it("maps inputsFrom and position into the run spec", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-pack-dag-"));
    await writePack(dir, DAG_STAGES);

    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }

    const built = await buildPackRun(loaded, { workflow: "dag-demo" });
    const runId = built.input.runId;
    const [research, write, review, publish] = built.input.stages;

    expect(research?.inputsFromStageIds).toBeUndefined();
    expect(write?.inputsFromStageIds).toEqual([`${runId}:research`]);
    expect(review?.position).toEqual({ x: 40, y: 160 });
    expect(publish?.inputsFromStageIds).toEqual([
      `${runId}:write`,
      `${runId}:review`,
    ]);
  });

  it("rejects inputsFrom referencing a later stage", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-pack-dag-"));
    await writePack(
      dir,
      `  - id: first
    type: agent
    agent: echo
    inputs: [request]
    outputs: [notes]
    inputsFrom: [second]
  - id: second
    type: agent
    agent: echo
    inputs: [notes]
    outputs: [draft]
`,
    );

    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) {
      return;
    }
    expect(loaded.errors.join("\n")).toContain(
      "must reference an earlier stage",
    );
  });

  it("rejects mixing inputFrom and inputsFrom", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-pack-dag-"));
    await writePack(
      dir,
      `  - id: first
    type: agent
    agent: echo
    inputs: [request]
    outputs: [notes]
  - id: second
    type: agent
    agent: echo
    inputs: [notes]
    outputs: [draft]
    inputFrom: first
    inputsFrom: [first]
`,
    );

    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) {
      return;
    }
    expect(loaded.errors.join("\n")).toContain(
      "use inputFrom or inputsFrom, not both",
    );
  });

  it("persists stage positions into the workflow YAML", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-pack-dag-"));
    await writePack(dir, DAG_STAGES);

    const content = await setStagePositions(dir, "workflows/dag.yaml", {
      research: { x: 12, y: 24 },
      write: { x: 300.4, y: 40.6 },
      missing: { x: 1, y: 1 },
    });

    const doc = parse(content) as {
      stages?: Array<{ id?: string; position?: { x: number; y: number } }>;
    };
    const byId = new Map(
      (doc.stages ?? []).map((stage) => [stage.id, stage.position]),
    );
    expect(byId.get("research")).toEqual({ x: 12, y: 24 });
    expect(byId.get("write")).toEqual({ x: 300, y: 41 });
    expect(byId.get("review")).toEqual({ x: 40, y: 160 });

    const onDisk = await readFile(
      path.join(dir, "workflows", "dag.yaml"),
      "utf8",
    );
    expect(onDisk).toContain("position:");

    const reloaded = await loadPack(dir);
    expect(reloaded.ok).toBe(true);
  });
});
