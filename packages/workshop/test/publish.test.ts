import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  installWorkshop,
  listInstalledWorkshop,
  publishWorkshop,
} from "../src";

const SHA = "a".repeat(40);
const roots: string[] = [];

const TEAM = `apiVersion: agentteam/v1
kind: TeamPack
metadata:
  name: demo-team
  version: 1.0.0
  description: Demo team
  license: Apache-2.0
  compatibility:
    kit: ">=0.1 <2.0"
manager:
  agent: agents/echo.md
agents:
  - id: echo
    file: agents/echo.md
    model: deepseek-flash
    tools: []
    skills: []
workspaces:
  default:
    agents: [echo]
    delivery: local_file
workflows:
  - workflows/demo.yaml
policies:
  - policies/autonomy.yaml
`;

const AGENT = `---
name: echo
description: Echo agent
model: deepseek-flash
tools: []
skills: []
permissions:
  filesystem: readonly
  network: none
---

Repeat the task input.
`;

const WORKFLOW = `id: demo
version: 1.0
trigger:
  event: demo.event.received
stages:
  - id: echo
    type: agent
    agent: echo
    inputs: [event]
    outputs: [result]
`;

const POLICY = `version: 1
actions:
  - match: tool.echo
    class: A
`;

const README = "# Demo team\n";

const WORKFLOW_MANIFEST = `apiVersion: agentteam/v1
kind: workflow
id: demo-flow
name: Demo Flow
version: 1.0.0
entry: workflows/demo.yaml
files:
  - workflows/demo.yaml
topics:
  - agent-team-workshop
license: Apache-2.0
permissions:
  code: false
  filesystem: none
`;

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kit-publish-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

function makePack(overrides: Record<string, string> = {}): Promise<string> {
  return makeDir({
    "team.yaml": TEAM,
    "agents/echo.md": AGENT,
    "workflows/demo.yaml": WORKFLOW,
    "policies/autonomy.yaml": POLICY,
    "README.md": README,
    ...overrides,
  });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function text(value: string) {
  return new Response(value, { status: 200 });
}

describe("workshop publish", () => {
  it("generates and writes a manifest for a local pack", async () => {
    const dir = await makePack();
    const result = await publishWorkshop({ dir, write: true });

    expect(result.ok).toBe(true);
    expect(result.generated).toBe(true);
    expect(result.written).toBe(true);
    expect(result.manifest.kind).toBe("pack");
    expect(result.manifest.id).toBe("demo-team");
    expect(result.manifest.entry).toBe("team.yaml");
    expect(result.manifest.files).toContain("agents/echo.md");
    expect(result.manifest.files).not.toContain("workshop.yaml");
    expect(result.manifest.permissions.code).toBe(false);
    expect(result.risk.level).toBe("medium");

    const written = parse(
      await readFile(path.join(dir, "workshop.yaml"), "utf8"),
    ) as { id: string };
    expect(written.id).toBe("demo-team");

    const team = result.files.find((file) => file.path === "team.yaml");
    expect(team?.sha256).toBe(
      sha256(await readFile(path.join(dir, "team.yaml"))),
    );
    expect(
      result.checks.some(
        (item) => item.id === "pack" && item.status === "pass",
      ),
    ).toBe(true);
  });

  it("can generate without writing when write is false", async () => {
    const dir = await makePack();
    const result = await publishWorkshop({ dir, write: false });

    expect(result.generated).toBe(true);
    expect(result.written).toBe(false);
    await expect(
      readFile(path.join(dir, "workshop.yaml"), "utf8"),
    ).rejects.toThrow();
  });

  it("validates an existing manifest and hashes declared files", async () => {
    const dir = await makeDir({
      "workshop.yaml": WORKFLOW_MANIFEST,
      "workflows/demo.yaml": WORKFLOW,
      "README.md": README,
    });
    const result = await publishWorkshop({ dir });

    expect(result.ok).toBe(true);
    expect(result.generated).toBe(false);
    expect(result.manifest.kind).toBe("workflow");
    expect(result.manifest.permissions.filesystem).toBe("none");
    const file = result.files.find(
      (entry) => entry.path === "workflows/demo.yaml",
    );
    expect(file?.sha256).toBe(sha256(WORKFLOW));
  });

  it("fails when a declared file is missing", async () => {
    const dir = await makeDir({
      "workshop.yaml": WORKFLOW_MANIFEST,
      "README.md": README,
    });
    const result = await publishWorkshop({ dir });

    expect(result.ok).toBe(false);
    expect(result.checks.find((item) => item.id === "files")?.status).toBe(
      "fail",
    );
  });

  it("detects command adapters and marks the manifest as code", async () => {
    const dir = await makePack({
      "tools/shell.yaml": `name: shell
description: Run a shell command
adapter: command
`,
    });
    const result = await publishWorkshop({ dir, write: false });

    expect(result.ok).toBe(true);
    expect(result.manifest.permissions.code).toBe(true);
    expect(result.risk.level).toBe("high");
    expect(result.checks.find((item) => item.id === "code")?.status).toBe(
      "warn",
    );
  });
});

describe("workshop install records", () => {
  it("lists installed records with pinned commit and manifest hash", async () => {
    const workflow = "id: demo-flow\nversion: 1.0\n";
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/demo")) {
        return json({ default_branch: "main" });
      }
      if (url.includes("/commits/")) {
        return json({ sha: SHA });
      }
      if (url.endsWith("/workshop.yaml")) {
        return text(WORKFLOW_MANIFEST);
      }
      if (url.endsWith("/workflows/demo.yaml")) {
        return text(workflow);
      }
      return new Response("not found", { status: 404 });
    });

    const root = await mkdtemp(path.join(tmpdir(), "kit-workshop-"));
    roots.push(root);
    const installed = await installWorkshop({
      repo: "acme/demo",
      root,
      acceptThirdParty: true,
    });

    expect(installed.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    const records = await listInstalledWorkshop(root);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "workflow",
      name: "Demo Flow",
      version: "1.0.0",
      repo: "acme/demo",
      commit: SHA,
      manifestSha256: installed.manifestSha256,
      fileCount: 1,
    });
  });
});
