import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPack } from "../src/load-pack";
import { buildPackRun } from "../src/pack-run";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("coder stage", () => {
  it("loads and builds a coder stage", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-pack-coder-"));
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
  name: coder-demo
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
  - workflows/coder.yaml
policies: []
`,
      "utf8",
    );
    await writeFile(
      path.join(dir, "workflows", "coder.yaml"),
      `id: coder-demo
version: 1.0
trigger:
  event: demo.requested
stages:
  - id: build
    type: coder
    coder: command
    goal: add a file
    acceptance: the file exists
    inputs: [request]
    outputs: [patch]
    timeout: 5m
`,
      "utf8",
    );

    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    const built = await buildPackRun(loaded, { workflow: "coder-demo" });
    const stage = built.input.stages[0];
    expect(stage?.type).toBe("coder");
    expect(stage?.coder).toBe("command");
    expect(stage?.goal).toBe("add a file");
    expect(stage?.acceptance).toBe("the file exists");
    expect(stage?.timeoutMs).toBe(5 * 60 * 1000);
  });
});
