import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AssemblyError,
  assembleComponents,
  createPack,
  loadPack,
} from "@kit/pack";
import { afterEach, describe, expect, it } from "vitest";
import {
  listComponents,
  readAssemblyLock,
  verifyAssemblyLock,
  workshopComponentLibrary,
} from "../src";

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

async function writeComponent(
  componentsRoot: string,
  file: string,
  content: string,
): Promise<void> {
  const destination = path.join(componentsRoot, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
}

const AGENT = `---
name: echo
description: Echo the input
model: deepseek-flash
role: builder
tools: [weather_lookup]
skills: []
---
Echo the input verbatim.
`;

const TOOLPACK = `apiVersion: agentteam/v1
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

const WORKFLOW = `id: review
version: 1.0
trigger:
  event: task.received
stages:
  - id: echo
    type: agent
    agent: echo
    inputs: [task]
    outputs: [result]
`;

async function seedLibrary(): Promise<string> {
  const componentsRoot = await tempRoot("kit-components-");
  await writeComponent(componentsRoot, "agent/echo/agent.md", AGENT);
  await writeComponent(
    componentsRoot,
    "toolpack/weather/toolpack.yaml",
    TOOLPACK,
  );
  await writeComponent(
    componentsRoot,
    "workflow/review/workflow.yaml",
    WORKFLOW,
  );
  return componentsRoot;
}

async function makePack(): Promise<string> {
  const root = await tempRoot("kit-assembly-pack-");
  await createPack({
    root,
    dirName: "minimal-team",
    name: "Minimal Team",
    template: "minimal",
  });
  return path.join(root, "minimal-team");
}

describe("workshop component assembly (end to end)", () => {
  it("binds real library components into a pack and records the lockfile", async () => {
    const componentsRoot = await seedLibrary();
    const packDir = await makePack();

    const result = await assembleComponents(
      {
        packDir,
        components: [
          { kind: "agent", id: "echo" },
          { kind: "toolpack", id: "weather" },
          { kind: "workflow", id: "review" },
        ],
      },
      workshopComponentLibrary(componentsRoot),
    );

    expect(result.noop).toBe(false);
    expect(result.bindings).toHaveLength(3);

    const loaded = await loadPack(packDir);
    if (!loaded.ok) {
      throw new Error(loaded.errors.join("; "));
    }
    expect(loaded.agents.has("echo")).toBe(true);
    expect(loaded.pack.workflows).toContain("workflows/review.yaml");

    // The component's instructions body is preserved verbatim.
    const echoMd = await readFile(
      path.join(packDir, "agents", "echo.md"),
      "utf8",
    );
    expect(echoMd).toContain("Echo the input verbatim.");

    const lock = await readAssemblyLock(packDir);
    expect(lock.ok).toBe(true);
    expect(lock.lock.components).toHaveLength(3);
    expect(lock.lock.bindings).toHaveLength(3);

    const verified = await verifyAssemblyLock(lock.lock, componentsRoot);
    expect(verified.ok).toBe(true);

    const listed = await listComponents(componentsRoot, { lock: lock.lock });
    expect(listed.every((component) => component.bound)).toBe(true);
  });

  it("plans an assembly without writing anything in dry-run mode", async () => {
    const componentsRoot = await seedLibrary();
    const packDir = await makePack();
    const teamBefore = await readFile(path.join(packDir, "team.yaml"), "utf8");

    const result = await assembleComponents(
      {
        packDir,
        components: [
          { kind: "agent", id: "echo" },
          { kind: "toolpack", id: "weather" },
        ],
        dryRun: true,
      },
      workshopComponentLibrary(componentsRoot),
    );

    expect(result.preview).toBe(true);
    expect(result.bindings).toHaveLength(2);
    expect(result.written).toEqual([
      "toolpacks/weather.yaml",
      "agents/echo.md",
    ]);
    expect(existsSync(path.join(packDir, "agents", "echo.md"))).toBe(false);
    expect(existsSync(path.join(packDir, "toolpacks", "weather.yaml"))).toBe(
      false,
    );
    expect(existsSync(path.join(packDir, "components.lock.json"))).toBe(false);
    expect(await readFile(path.join(packDir, "team.yaml"), "utf8")).toBe(
      teamBefore,
    );
  });

  it("rejects an out-of-bounds workflow and leaves no partial pack", async () => {
    const componentsRoot = await seedLibrary();
    await writeComponent(
      componentsRoot,
      "workflow/dangling/workflow.yaml",
      `id: dangling
version: 1.0
trigger:
  event: task.received
stages:
  - id: run
    type: agent
    agent: does-not-exist
    inputs: [task]
    outputs: [result]
`,
    );
    const packDir = await makePack();
    const before = await readFile(path.join(packDir, "team.yaml"), "utf8");

    await expect(
      assembleComponents(
        { packDir, components: [{ kind: "workflow", id: "dangling" }] },
        workshopComponentLibrary(componentsRoot),
      ),
    ).rejects.toBeInstanceOf(AssemblyError);

    expect(existsSync(path.join(packDir, "components.lock.json"))).toBe(false);
    expect(existsSync(path.join(packDir, "workflows", "dangling.yaml"))).toBe(
      false,
    );
    expect(await readFile(path.join(packDir, "team.yaml"), "utf8")).toBe(
      before,
    );
  });
});
