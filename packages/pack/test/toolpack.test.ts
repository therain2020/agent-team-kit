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

const WEATHER_TOOLPACK = `apiVersion: agentteam/v1
kind: ToolPack
name: weather
version: 1.0.0
tools:
  - name: weather_lookup
    description: Look up the weather
    risk: network
    adapter: http
    endpoint: https://api.example.com/weather
    method: GET
    permissions:
      network: true
`;

const WRITER_SKILLPACK = `apiVersion: agentteam/v1
kind: SkillPack
name: writer
version: 1.0.0
entry: skills/writer/SKILL.md
files:
  - skills/writer/SKILL.md
`;

interface SetupOptions {
  tools?: string[];
  skills?: string[];
  toolpacks?: string[];
  skillpacks?: string[];
  files?: Record<string, string>;
}

async function setup(options: SetupOptions = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-toolpack-"));
  dirs.push(dir);
  const tools = options.tools ?? [];
  const skills = options.skills ?? [];
  const toolpacks = options.toolpacks ?? [];
  const skillpacks = options.skillpacks ?? [];

  await mkdir(path.join(dir, "agents"), { recursive: true });
  await mkdir(path.join(dir, "workflows"), { recursive: true });
  await writeFile(
    path.join(dir, "agents", "researcher.md"),
    `---
name: researcher
description: Research agent
model: deepseek-flash
tools: [${tools.join(", ")}]
skills: [${skills.join(", ")}]
---

Research.
`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "team.yaml"),
    `apiVersion: agentteam/v1
kind: TeamPack
metadata:
  name: tool-demo
  version: 1.0.0
  compatibility:
    kit: ">=0.1 <2.0"
agents:
  - id: researcher
    file: agents/researcher.md
    model: deepseek-flash
    tools: [${tools.join(", ")}]
    skills: [${skills.join(", ")}]
workflows:
  - workflows/main.yaml
policies: []
toolpacks: [${toolpacks.join(", ")}]
skillpacks: [${skillpacks.join(", ")}]
`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "workflows", "main.yaml"),
    `id: main
version: 1.0
trigger:
  event: demo.requested
stages:
  - id: work
    type: agent
    agent: researcher
    inputs: [request]
    outputs: [result]
`,
    "utf8",
  );

  for (const [file, content] of Object.entries(options.files ?? {})) {
    const destination = path.join(dir, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }

  return dir;
}

describe("toolpacks", () => {
  it("loads toolpacks and attaches declared tools to the stage", async () => {
    const dir = await setup({
      tools: ["weather_lookup"],
      toolpacks: ["tools/weather.yaml"],
      files: { "tools/weather.yaml": WEATHER_TOOLPACK },
    });

    const loaded = await loadPack(dir);
    if (!loaded.ok) {
      throw new Error(loaded.errors.join("; "));
    }
    expect(loaded.toolPacks).toHaveLength(1);
    expect(loaded.toolPacks[0]?.tools[0]?.name).toBe("weather_lookup");

    const built = await buildPackRun(loaded);
    expect(built.input.stages[0]?.packTools?.[0]?.name).toBe("weather_lookup");
  });

  it("only attaches tools the agent declares", async () => {
    const dir = await setup({
      tools: ["repo_read"],
      toolpacks: ["tools/weather.yaml"],
      files: { "tools/weather.yaml": WEATHER_TOOLPACK },
    });

    const loaded = await loadPack(dir);
    if (!loaded.ok) {
      throw new Error(loaded.errors.join("; "));
    }
    const built = await buildPackRun(loaded);
    expect(built.input.stages[0]?.packTools).toBeUndefined();
  });

  it("rejects a missing toolpack file", async () => {
    const dir = await setup({ toolpacks: ["tools/missing.yaml"] });
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errors.join("; ")).toContain("toolpack file missing");
    }
  });

  it("rejects secrets inside a toolpack", async () => {
    const dir = await setup({
      toolpacks: ["tools/weather.yaml"],
      files: {
        "tools/weather.yaml": `${WEATHER_TOOLPACK}# sk-1234567890abcdef\n`,
      },
    });
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errors.join("; ")).toContain("possible secret");
    }
  });

  it("rejects tool names that collide with builtins", async () => {
    const dir = await setup({
      toolpacks: ["tools/weather.yaml"],
      files: {
        "tools/weather.yaml": WEATHER_TOOLPACK.replace(
          "weather_lookup",
          "repo_read",
        ),
      },
    });
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errors.join("; ")).toContain(
        "conflicts with a builtin tool",
      );
    }
  });

  it("rejects oversized toolpack files", async () => {
    const dir = await setup({
      toolpacks: ["tools/weather.yaml"],
      files: {
        "tools/weather.yaml": `${WEATHER_TOOLPACK}\n# ${"x".repeat(257 * 1024)}\n`,
      },
    });
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errors.join("; ")).toContain("exceeds 256KB");
    }
  });
});

describe("skillpacks", () => {
  it("loads skillpack skills for agents to reference", async () => {
    const dir = await setup({
      skills: ["writer"],
      skillpacks: ["skills/writer/skillpack.yaml"],
      files: {
        "skills/writer/skillpack.yaml": WRITER_SKILLPACK,
        "skills/writer/SKILL.md": `---
name: writer
description: Write drafts
---

Write clearly.
`,
      },
    });

    const loaded = await loadPack(dir);
    if (!loaded.ok) {
      throw new Error(loaded.errors.join("; "));
    }
    expect(loaded.skillPacks).toHaveLength(1);
    expect(loaded.skills.get("writer")?.description).toBe("Write drafts");
  });
});
