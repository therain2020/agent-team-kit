import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadPack } from "../src/load-pack";
import { buildPackRun } from "../src/pack-run";
import { setStageEdges } from "../src/pack-studio";

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
  name: edge-demo
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
  - workflows/flow.yaml
policies: []
`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "workflows", "flow.yaml"),
    `id: edge-demo
version: 1.0
trigger:
  event: demo.requested
stages:
${stages}`,
    "utf8",
  );
}

const CHAIN_STAGES = `  - id: intake
    type: agent
    agent: echo
    inputs: [request]
    outputs: [brief]
  - id: draft
    type: agent
    agent: echo
    inputs: [brief]
    outputs: [draft]
  - id: polish
    type: agent
    agent: echo
    inputs: [draft]
    outputs: [final]
`;

interface ParsedStage {
  id: string;
  inputFrom?: string;
  inputsFrom?: string[];
  position?: { x: number; y: number };
}

function stagesOf(content: string): ParsedStage[] {
  const doc = parse(content) as { stages?: ParsedStage[] };
  return doc.stages ?? [];
}

describe("workflow canvas edges", () => {
  it("persists edges as explicit inputs and feed the runtime", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-pack-edges-"));
    await writePack(dir, CHAIN_STAGES);

    const content = await setStageEdges(dir, "workflows/flow.yaml", [
      { from: "intake", to: "draft" },
      { from: "intake", to: "polish" },
    ]);

    const stages = stagesOf(content);
    expect(stages.map((stage) => stage.id)).toEqual([
      "intake",
      "draft",
      "polish",
    ]);
    expect(stages[0]?.inputFrom).toBeUndefined();
    expect(stages[1]?.inputFrom).toBe("intake");
    expect(stages[2]?.inputFrom).toBe("intake");

    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    const built = await buildPackRun(loaded, { workflow: "edge-demo" });
    const runId = built.input.runId;
    expect(built.input.stages.map((stage) => stage.inputFromStageId)).toEqual([
      undefined,
      `${runId}:intake`,
      `${runId}:intake`,
    ]);
    expect(built.input.stages.map((stage) => stage.inputsFromStageIds)).toEqual(
      [undefined, undefined, undefined],
    );
  });

  it("merges multiple upstream stages into inputsFrom", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-pack-edges-"));
    await writePack(dir, CHAIN_STAGES);

    const content = await setStageEdges(dir, "workflows/flow.yaml", [
      { from: "intake", to: "draft" },
      { from: "intake", to: "polish" },
      { from: "draft", to: "polish" },
    ]);

    const stages = stagesOf(content);
    expect(stages[2]?.inputsFrom).toEqual(["intake", "draft"]);
    expect(stages[2]?.inputFrom).toBeUndefined();
  });

  it("re-orders stages so upstream stages come first", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-pack-edges-"));
    await writePack(
      dir,
      `  - id: intake
    type: agent
    agent: echo
    inputs: [request]
    outputs: [brief]
  - id: draft
    type: agent
    agent: echo
    inputs: [brief]
    outputs: [draft]
  - id: polish
    type: agent
    agent: echo
    inputs: [draft]
    outputs: [final]
    position: {x: 40, y: 160}
`,
    );

    const content = await setStageEdges(dir, "workflows/flow.yaml", [
      { from: "intake", to: "polish" },
      { from: "polish", to: "draft" },
    ]);

    const stages = stagesOf(content);
    expect(stages.map((stage) => stage.id)).toEqual([
      "intake",
      "polish",
      "draft",
    ]);
    expect(stages[2]?.inputFrom).toBe("polish");
    expect(stages[1]?.position).toEqual({ x: 40, y: 160 });

    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
  });

  it("rejects cycles", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-pack-edges-"));
    await writePack(dir, CHAIN_STAGES);

    await expect(
      setStageEdges(dir, "workflows/flow.yaml", [
        { from: "intake", to: "draft" },
        { from: "draft", to: "intake" },
      ]),
    ).rejects.toThrow(/cycle/);

    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
  });

  it("rejects a second entry stage", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-pack-edges-"));
    await writePack(dir, CHAIN_STAGES);

    await expect(setStageEdges(dir, "workflows/flow.yaml", [])).rejects.toThrow(
      /exactly one entry stage/,
    );

    await expect(
      setStageEdges(dir, "workflows/flow.yaml", [
        { from: "intake", to: "draft" },
      ]),
    ).rejects.toThrow(/found: intake, polish/);
  });

  it("rejects unknown, self and duplicate edges", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-pack-edges-"));
    await writePack(dir, CHAIN_STAGES);

    await expect(
      setStageEdges(dir, "workflows/flow.yaml", [
        { from: "intake", to: "missing" },
      ]),
    ).rejects.toThrow(/unknown stage/);

    await expect(
      setStageEdges(dir, "workflows/flow.yaml", [
        { from: "intake", to: "intake" },
      ]),
    ).rejects.toThrow(/cannot depend on itself/);

    await expect(
      setStageEdges(dir, "workflows/flow.yaml", [
        { from: "intake", to: "draft" },
        { from: "intake", to: "draft" },
      ]),
    ).rejects.toThrow(/duplicate edge/);
  });
});
