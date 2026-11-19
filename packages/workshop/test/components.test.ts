import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assemblyLockPath,
  buildComponentRef,
  componentContentHash,
  isComponentBound,
  listComponents,
  loadComponent,
  readAssemblyLock,
  upsertLockedComponent,
  validateAssetEntry,
  verifyAssemblyLock,
  writeAssemblyLock,
} from "../src";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const AGENT = `---
name: echo
description: Echo agent
model: deepseek-flash
tools: []
skills: []
---

Echo the input verbatim.
`;

const WORKFLOW = `id: demo-flow
version: 1.0
trigger:
  event: demo.requested
stages:
  - id: worker
    type: agent
    agent: worker
    inputs: [task]
    outputs: [result]
`;

const TOOLPACK = `apiVersion: agentteam/v1
kind: ToolPack
name: weather
version: 1.0.0
tools:
  - name: weather_lookup
    description: Look up weather
    risk: network
    adapter: http
    endpoint: https://api.example.com/weather
    permissions:
      network: true
`;

const SKILLPACK = `apiVersion: agentteam/v1
kind: SkillPack
name: writer
version: 1.0.0
entry: skills/writer/SKILL.md
files:
  - skills/writer/SKILL.md
`;

const SKILL = `---
name: writer
description: Write drafts
---

Write clearly.
`;

const PIPELINE = `apiVersion: agentteam/v1
kind: Pipeline
id: demo-pipeline
version: 1.0.0
graph:
  nodes:
    - id: draft
      type: agent
    - id: review
      type: human
  edges:
    - from: draft
      to: review
`;

const SOURCE = `apiVersion: agentteam/source/v1
kind: Source
metadata:
  name: hackernews
  version: 1.0.0
spec:
  type: rss
  request:
    url: https://news.ycombinator.com/rss
`;

const TEMPLATE = `apiVersion: agentteam/v1
kind: TeamTemplate
id: minimal
name: Minimal Team
workflow:
  id: starter
  version: 1.0
  trigger:
    event: task.received
  stages:
    - id: worker
      type: agent
      agent: worker
      inputs: [task]
      outputs: [worker_output]
policy:
  version: 1
  actions:
    - {match: "tool.web_search", class: "A"}
autopilot:
  version: 1
  enabled: false
  timezone: Asia/Shanghai
  schedules: []
  iterations: []
  approval:
    autoApprove:
      enabled: false
      maxRisk: low
      onTimeout: wait
  evolution:
    enabled: false
    cadence: weekly
    autoApply: false
`;

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kit-components-"));
  roots.push(root);
  return root;
}

async function writeFiles(
  dir: string,
  files: Record<string, string>,
): Promise<string> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return dir;
}

async function addComponent(
  root: string,
  kind: string,
  id: string,
  files: Record<string, string>,
): Promise<string> {
  return writeFiles(path.join(root, kind, id), files);
}

describe("component library", () => {
  it("lists and validates every component kind", async () => {
    const root = await newRoot();
    await addComponent(root, "agent", "echo", { "agent.md": AGENT });
    await addComponent(root, "workflow", "demo", {
      "workflow.yaml": WORKFLOW,
    });
    await addComponent(root, "toolpack", "weather", {
      "toolpack.yaml": TOOLPACK,
    });
    await addComponent(root, "skillpack", "writer", {
      "skillpack.yaml": SKILLPACK,
      "skills/writer/SKILL.md": SKILL,
    });

    const list = await listComponents(root);
    expect(list.map((entry) => `${entry.kind}/${entry.id}`)).toEqual([
      "agent/echo",
      "skillpack/writer",
      "toolpack/weather",
      "workflow/demo",
    ]);
    expect(list.every((entry) => entry.valid)).toBe(true);
    const toolpack = list.find((entry) => entry.id === "weather");
    expect(toolpack?.version).toBe("1.0.0");
    expect(toolpack?.sha256).toHaveLength(64);
  });

  it("returns an empty list for a missing root", async () => {
    const root = await newRoot();
    expect(await listComponents(path.join(root, "does-not-exist"))).toEqual([]);
  });

  it("reports structured error codes for an id mismatch", async () => {
    const root = await newRoot();
    await addComponent(root, "agent", "echo", {
      "agent.md": AGENT.replace("name: echo", "name: other"),
    });

    const result = await loadComponent("agent", "echo", root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain("id_mismatch");
    }
  });

  it("rejects an entry that escapes the component directory", async () => {
    const root = await newRoot();
    await addComponent(root, "toolpack", "weather", {
      "toolpack.yaml": TOOLPACK,
      ".workshop.json": JSON.stringify({
        kind: "toolpack",
        id: "weather",
        entry: "../evil.yaml",
      }),
    });

    const result = await loadComponent("toolpack", "weather", root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain(
        "entry_escapes",
      );
    }
  });

  it("reports missing skillpack files", async () => {
    const root = await newRoot();
    await addComponent(root, "skillpack", "writer", {
      "skillpack.yaml": SKILLPACK,
    });

    const result = await loadComponent("skillpack", "writer", root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain(
        "file_missing",
      );
    }
  });

  it("detects secrets in component content", async () => {
    const root = await newRoot();
    await addComponent(root, "agent", "echo", {
      "agent.md": `${AGENT}\n# ghp_${"a".repeat(24)}\n`,
    });

    const result = await loadComponent("agent", "echo", root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain(
        "secret_detected",
      );
    }
  });
});

describe("component refs and lockfile", () => {
  it("pins an installed component to its provenance", async () => {
    const root = await newRoot();
    const dir = await addComponent(root, "toolpack", "weather", {
      "toolpack.yaml": TOOLPACK,
      ".workshop.json": JSON.stringify({
        kind: "toolpack",
        id: "weather",
        version: "1.0.0",
        entry: "toolpack.yaml",
        repo: "acme/components",
        commit: "c".repeat(40),
      }),
    });

    const ref = await buildComponentRef("toolpack", "weather", root);
    expect(ref.source.repo).toBe("acme/components");
    expect(ref.source.commit).toBe("c".repeat(40));
    expect(ref.source.sha256).toBe(await componentContentHash(dir));
    expect(ref.version).toBe("1.0.0");
  });

  it("gives a local component a content-derived source", async () => {
    const root = await newRoot();
    await addComponent(root, "agent", "echo", { "agent.md": AGENT });

    const ref = await buildComponentRef("agent", "echo", root);
    expect(ref.source.repo).toBe("local/echo");
    expect(ref.source.ref).toBe("local");
    expect(ref.source.commit).toHaveLength(40);
    expect(ref.source.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("writes, reads and verifies a lockfile", async () => {
    const root = await newRoot();
    await addComponent(root, "toolpack", "weather", {
      "toolpack.yaml": TOOLPACK,
    });
    const packDir = path.join(root, "pack");
    const ref = await buildComponentRef("toolpack", "weather", root);

    const written = await upsertLockedComponent(packDir, ref);
    expect(written.ok).toBe(true);
    expect(assemblyLockPath(packDir)).toBe(
      path.join(packDir, "components.lock.json"),
    );

    const read = await readAssemblyLock(packDir);
    expect(read.ok).toBe(true);
    expect(read.exists).toBe(true);
    expect(read.lock.components).toHaveLength(1);

    const verified = await verifyAssemblyLock(read.lock, root);
    expect(verified.ok).toBe(true);
    expect(verified.entries[0]?.status).toBe("ok");
    expect(verified.entries[0]?.bound).toBe(false);
  });

  it("detects content drift against the lockfile", async () => {
    const root = await newRoot();
    await addComponent(root, "toolpack", "weather", {
      "toolpack.yaml": TOOLPACK,
    });
    const ref = await buildComponentRef("toolpack", "weather", root);

    await writeFile(
      path.join(root, "toolpack", "weather", "toolpack.yaml"),
      TOOLPACK.replace("Look up weather", "Look up the weather"),
      "utf8",
    );

    const base = (await readAssemblyLock(root)).lock;
    const verified = await verifyAssemblyLock(
      { ...base, components: [ref] },
      root,
    );
    expect(verified.ok).toBe(false);
    expect(verified.entries[0]?.status).toBe("hash-mismatch");
    expect(verified.issues.map((issue) => issue.code)).toContain(
      "lock_hash_mismatch",
    );
  });

  it("detects a version mismatch against the lockfile", async () => {
    const root = await newRoot();
    await addComponent(root, "toolpack", "weather", {
      "toolpack.yaml": TOOLPACK,
    });
    const ref = await buildComponentRef("toolpack", "weather", root);

    const base = (await readAssemblyLock(root)).lock;
    const verified = await verifyAssemblyLock(
      { ...base, components: [{ ...ref, version: "9.9.9" }] },
      root,
    );
    expect(verified.entries[0]?.status).toBe("version-mismatch");
  });

  it("marks a component bound only when a node references it", async () => {
    const root = await newRoot();
    await addComponent(root, "toolpack", "weather", {
      "toolpack.yaml": TOOLPACK,
    });
    const packDir = path.join(root, "pack");
    const ref = await buildComponentRef("toolpack", "weather", root);
    const base = (await readAssemblyLock(root)).lock;
    await writeAssemblyLock(packDir, { ...base, components: [ref] });

    const unbound = await readAssemblyLock(packDir);
    expect(isComponentBound(unbound.lock, ref)).toBe(false);
    expect((await listComponents(root, { lock: unbound.lock }))[0]?.bound).toBe(
      false,
    );

    await writeAssemblyLock(packDir, {
      ...base,
      components: [ref],
      bindings: [{ node: "draft", component: ref }],
    });
    const bound = await readAssemblyLock(packDir);
    expect(isComponentBound(bound.lock, ref)).toBe(true);
    expect((await listComponents(root, { lock: bound.lock }))[0]?.bound).toBe(
      true,
    );
  });
});

describe("asset entry validation", () => {
  it("validates pipeline, source and template entries", async () => {
    const root = await newRoot();
    const pipelineDir = await writeFiles(path.join(root, "pipeline"), {
      "pipeline.yaml": PIPELINE,
    });
    const sourceDir = await writeFiles(path.join(root, "source"), {
      "source.yaml": SOURCE,
    });
    const templateDir = await writeFiles(path.join(root, "template"), {
      "template.yaml": TEMPLATE,
    });

    for (const [kind, dir] of [
      ["pipeline", pipelineDir],
      ["source", sourceDir],
      ["template", templateDir],
    ] as const) {
      const result = await validateAssetEntry({ kind, dir });
      expect(result.ok, `${kind}: ${JSON.stringify(result.issues)}`).toBe(true);
    }
  });

  it("rejects a wrong entry filename and a missing entry", async () => {
    const root = await newRoot();
    const dir = await writeFiles(path.join(root, "pipeline"), {
      "pipeline.yaml": PIPELINE,
    });
    const wrongEntry = await validateAssetEntry({
      kind: "pipeline",
      dir,
      entry: "workflow.yaml",
    });
    expect(wrongEntry.issues.map((issue) => issue.code)).toContain(
      "entry_convention",
    );

    const missing = await validateAssetEntry({
      kind: "source",
      dir,
    });
    expect(missing.ok).toBe(false);
    expect(missing.issues.map((issue) => issue.code)).toContain(
      "entry_missing",
    );
  });

  it("rejects invalid pipeline content", async () => {
    const root = await newRoot();
    const dir = await writeFiles(path.join(root, "pipeline"), {
      "pipeline.yaml": "id: broken\nversion: 1.0.0\ngraph:\n  nodes: []\n",
    });
    const result = await validateAssetEntry({ kind: "pipeline", dir });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("entry_invalid");
  });
});
