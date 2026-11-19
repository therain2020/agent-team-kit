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

const PIPELINE = `apiVersion: agentteam/v1
kind: Pipeline
id: demo-pipeline
name: Demo Pipeline
version: "1.0"
description: A demo pipeline
graph:
  nodes:
    - id: plan
      type: human
      inputs: [task]
      outputs: [plan]
`;

const TEMPLATE = `apiVersion: agentteam/v1
kind: TeamTemplate
id: demo-template
name: Demo Template
description: Demo template
roles:
  requireSeller: false
  requireBuilder: true
  allowCombined: true
agents: []
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
      outputs: [result]
policy:
  version: 1
  actions:
    - match: tool.web_search
      class: A
autopilot:
  version: 1
`;

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
    expect(result.manifest?.kind).toBe("pack");
    expect(result.manifest?.id).toBe("demo-team");
    expect(result.manifest?.entry).toBe("team.yaml");
    expect(result.manifest?.files).toContain("agents/echo.md");
    expect(result.manifest?.files).not.toContain("workshop.yaml");
    expect(result.manifest?.permissions.code).toBe(false);
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
    expect(result.manifest?.kind).toBe("workflow");
    expect(result.manifest?.permissions.filesystem).toBe("none");
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
    expect(result.manifest?.permissions.code).toBe(true);
    expect(result.risk.level).toBe("high");
    expect(result.checks.find((item) => item.id === "code")?.status).toBe(
      "warn",
    );
  });
});

describe("workshop publish by kind", () => {
  const CHECKLIST = [
    "entry",
    "files",
    "size",
    "secret",
    "code",
    "readme",
    "license",
    "topic",
    "signature",
  ] as const;

  it("generates manifests for pack, pipeline, component and template with one checklist", async () => {
    const cases = [
      { dir: await makePack(), kind: "pack", publisher: "pack" },
      {
        dir: await makeDir({ "pipeline.yaml": PIPELINE, "README.md": README }),
        kind: "pipeline",
        publisher: "pipeline",
      },
      {
        dir: await makeDir({ "workflow.yaml": WORKFLOW, "README.md": README }),
        kind: "workflow",
        publisher: "component",
      },
      {
        dir: await makeDir({ "template.yaml": TEMPLATE, "README.md": README }),
        kind: "template",
        publisher: "template",
      },
    ] as const;

    for (const item of cases) {
      const result = await publishWorkshop({ dir: item.dir, write: false });

      expect(result.ok, `${item.kind}: ${JSON.stringify(result.checks)}`).toBe(
        true,
      );
      expect(result.generated).toBe(true);
      expect(result.kind).toBe(item.kind);
      expect(result.publisher).toBe(item.publisher);
      for (const id of CHECKLIST) {
        expect(
          result.checks.some((entry) => entry.id === id),
          `${item.kind} runs the ${id} check`,
        ).toBe(true);
      }
    }
  });

  it("normalises x.y versions and writes a pipeline manifest", async () => {
    const dir = await makeDir({
      "pipeline.yaml": PIPELINE,
      "README.md": README,
    });
    const result = await publishWorkshop({ dir, write: true });

    expect(result.ok).toBe(true);
    expect(result.written).toBe(true);
    expect(result.manifest?.entry).toBe("pipeline.yaml");
    expect(result.manifest?.version).toBe("1.0.0");
    expect(
      result.checks.some(
        (entry) => entry.id === "pipeline" && entry.status === "pass",
      ),
    ).toBe(true);

    const written = parse(
      await readFile(path.join(dir, "workshop.yaml"), "utf8"),
    ) as { kind: string; entry: string };
    expect(written.kind).toBe("pipeline");
    expect(written.entry).toBe("pipeline.yaml");
  });

  it("validates a generated manifest on the next run", async () => {
    const dir = await makeDir({
      "pipeline.yaml": PIPELINE,
      "README.md": README,
    });
    const first = await publishWorkshop({ dir, write: true });
    expect(first.written).toBe(true);

    const second = await publishWorkshop({ dir });
    expect(second.ok).toBe(true);
    expect(second.generated).toBe(false);
    expect(second.kind).toBe("pipeline");
    expect(second.checks.find((entry) => entry.id === "pipeline")?.status).toBe(
      "pass",
    );
  });

  it("returns a readable failure when there is no entry", async () => {
    const dir = await makeDir({ "README.md": README });
    const result = await publishWorkshop({ dir });

    expect(result.ok).toBe(false);
    expect(result.manifest).toBeNull();
    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.detail).toContain("no workshop.yaml");
  });

  it("requires an explicit kind when component entries are ambiguous", async () => {
    const dir = await makeDir({
      "agent.md": AGENT,
      "workflow.yaml": WORKFLOW,
      "README.md": README,
    });
    const ambiguous = await publishWorkshop({ dir });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.publisher).toBeNull();

    const explicit = await publishWorkshop({ dir, kind: "agent" });
    expect(explicit.ok).toBe(true);
    expect(explicit.kind).toBe("agent");
    expect(explicit.manifest?.id).toBe("echo");
  });

  it("rejects templates without a README but still validates them", async () => {
    const dir = await makeDir({ "template.yaml": TEMPLATE });
    const result = await publishWorkshop({ dir, write: false });

    expect(result.ok).toBe(false);
    expect(result.checks.find((entry) => entry.id === "readme")?.status).toBe(
      "fail",
    );
    expect(result.checks.find((entry) => entry.id === "template")?.status).toBe(
      "pass",
    );
  });

  it("fails when secret-like content is published", async () => {
    const dir = await makeDir({
      "pipeline.yaml": PIPELINE,
      "README.md": "# Demo\n\nsk-ABCDEFGHIJKLMNOPQRST\n",
    });
    const result = await publishWorkshop({ dir, write: false });

    expect(result.ok).toBe(false);
    expect(result.checks.find((entry) => entry.id === "secret")?.status).toBe(
      "fail",
    );
  });

  it("rejects executable code that the manifest did not declare", async () => {
    const manifest = `apiVersion: agentteam/v1
kind: workflow
id: demo-flow
name: Demo Flow
version: 1.0.0
entry: workflows/demo.yaml
files:
  - workflows/demo.yaml
topics:
  - agent-team-workshop
permissions:
  code: false
  filesystem: none
`;
    const dir = await makeDir({
      "workshop.yaml": manifest,
      "workflows/demo.yaml": "name: shell\nadapter: command\n",
    });
    const result = await publishWorkshop({ dir });

    expect(result.ok).toBe(false);
    expect(result.checks.find((entry) => entry.id === "code")?.status).toBe(
      "fail",
    );
  });

  it("rejects a manifest whose entry is not listed", async () => {
    const manifest = `apiVersion: agentteam/v1
kind: workflow
id: demo-flow
name: Demo Flow
version: 1.0.0
entry: workflows/demo.yaml
files:
  - README.md
topics:
  - agent-team-workshop
permissions:
  code: false
  filesystem: none
`;
    const dir = await makeDir({
      "workshop.yaml": manifest,
      "README.md": README,
    });
    const result = await publishWorkshop({ dir });

    expect(result.ok).toBe(false);
    expect(result.manifest).toBeNull();
    expect(result.checks[0]?.detail).toContain("entry must be listed in files");
  });

  it("never calls the network while publishing", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("publish must not use the network");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const dir = await makeDir({
      "pipeline.yaml": PIPELINE,
      "README.md": README,
    });
    const result = await publishWorkshop({ dir, write: false });

    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
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
      acceptUnsigned: true,
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
