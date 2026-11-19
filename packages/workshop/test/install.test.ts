import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPack } from "@kit/pack";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importInstalledPack,
  installWorkshop,
  resolveInstallTarget,
} from "../src";

const SHA = "a".repeat(40);
const roots: string[] = [];

const PACK_MANIFEST = `apiVersion: agentteam/v1
kind: pack
id: demo-team
name: Demo Team
version: 1.0.0
description: A demo team
entry: team.yaml
files:
  - team.yaml
  - agents/echo.md
  - workflows/demo.yaml
  - policies/autonomy.yaml
permissions:
  code: false
  filesystem: readonly
`;

const WORKFLOW_MANIFEST = `apiVersion: agentteam/v1
kind: workflow
id: demo-flow
name: Demo Flow
version: 1.0.0
entry: workflows/demo.yaml
files:
  - workflows/demo.yaml
permissions:
  code: false
`;

const TEAM = `apiVersion: agentteam/v1
kind: TeamPack
metadata:
  name: demo-team
  version: 1.0.0
  description: Demo team
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

const PACK_FILES: Record<string, string> = {
  "team.yaml": TEAM,
  "agents/echo.md": AGENT,
  "workflows/demo.yaml": WORKFLOW,
  "policies/autonomy.yaml": POLICY,
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeRoots(): Promise<{ workshop: string; packs: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "kit-install-"));
  roots.push(base);
  return {
    workshop: path.join(base, "workshop"),
    packs: path.join(base, "packs"),
  };
}

function stubFetch(manifestText: string, files: Record<string, string>) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/repos/acme/demo")) {
      return json({ default_branch: "main" });
    }
    if (url.includes("/commits/")) {
      return json({ sha: SHA });
    }
    if (url.endsWith("/workshop.yaml")) {
      return text(manifestText);
    }
    const entry = Object.entries(files).find(([name]) =>
      url.endsWith(`/${name}`),
    );
    if (entry) {
      return text(entry[1]);
    }
    return new Response("not found", { status: 404 });
  });
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

function install(
  roots: { workshop: string; packs: string },
  overrides: { overwrite?: boolean } = {},
) {
  return installWorkshop({
    repo: "acme/demo",
    root: roots.workshop,
    packsRoot: roots.packs,
    acceptThirdParty: true,
    acceptUnsigned: true,
    acceptHighRisk: true,
    ...overrides,
  });
}

describe("workshop install destination", () => {
  it("selects packs/ for pack manifests, workshop/ otherwise", () => {
    const base = path.join(tmpdir(), "kit-install-target");
    const options = {
      root: path.join(base, "workshop"),
      packsRoot: path.join(base, "packs"),
    };

    const packTarget = resolveInstallTarget(
      { id: "demo-team", kind: "pack" },
      options,
    );
    expect(packTarget.scope).toBe("packs");
    expect(packTarget.dir).toBe(path.join(base, "packs", "demo-team"));

    const workflowTarget = resolveInstallTarget(
      { id: "demo-flow", kind: "workflow" },
      options,
    );
    expect(workflowTarget.scope).toBe("workshop");
    expect(workflowTarget.dir).toBe(path.join(base, "workshop", "demo-flow"));
  });

  it("installs pack items into the packs root with provenance", async () => {
    stubFetch(PACK_MANIFEST, PACK_FILES);
    const dirs = await makeRoots();

    const installed = await install(dirs);

    expect(installed.scope).toBe("packs");
    expect(installed.dir).toBe(path.join(dirs.packs, "demo-team"));
    expect(existsSync(path.join(dirs.workshop, "demo-team"))).toBe(false);

    const loaded = await loadPack(installed.dir);
    expect(loaded.ok).toBe(true);

    const record = JSON.parse(
      await readFile(path.join(installed.dir, ".workshop.json"), "utf8"),
    ) as Record<string, string>;
    expect(record.kind).toBe("pack");
    expect(record.repo).toBe("acme/demo");
    expect(record.commit).toBe(SHA);
    expect(record.manifestSha256).toHaveLength(64);

    expect(await readdir(dirs.packs)).toEqual(["demo-team"]);
  });

  it("keeps non-pack kinds in the workshop directory", async () => {
    stubFetch(WORKFLOW_MANIFEST, { "workflows/demo.yaml": WORKFLOW });
    const dirs = await makeRoots();

    const installed = await install(dirs);

    expect(installed.scope).toBe("workshop");
    expect(installed.dir).toBe(path.join(dirs.workshop, "demo-flow"));
    expect(existsSync(dirs.packs)).toBe(false);
  });
});

describe("workshop install conflicts", () => {
  it("refuses an existing target unless overwrite is requested", async () => {
    stubFetch(PACK_MANIFEST, PACK_FILES);
    const dirs = await makeRoots();
    const first = await install(dirs);
    await writeFile(path.join(first.dir, "marker.txt"), "old", "utf8");

    await expect(install(dirs)).rejects.toThrow(/already exists/);
    expect(await readFile(path.join(first.dir, "marker.txt"), "utf8")).toBe(
      "old",
    );

    const replaced = await install(dirs, { overwrite: true });
    expect(replaced.dir).toBe(first.dir);
    expect(existsSync(path.join(first.dir, "marker.txt"))).toBe(false);
    expect(await readdir(dirs.packs)).toEqual(["demo-team"]);
  });
});

describe("workshop install rollback", () => {
  it("leaves nothing behind when validation fails", async () => {
    stubFetch(PACK_MANIFEST, {
      ...PACK_FILES,
      // team.yaml points at an agent file that is never downloaded
      "team.yaml": TEAM.replace(
        "file: agents/echo.md",
        "file: agents/missing.md",
      ),
    });
    const dirs = await makeRoots();

    const attempt = install(dirs);
    await expect(attempt).rejects.toThrow(/installed pack is invalid/);
    expect(existsSync(path.join(dirs.packs, "demo-team"))).toBe(false);
    expect(await readdir(dirs.packs)).toEqual([]);
  });

  it("keeps the previous install when an overwrite fails", async () => {
    stubFetch(PACK_MANIFEST, PACK_FILES);
    const dirs = await makeRoots();
    const first = await install(dirs);
    await writeFile(path.join(first.dir, "marker.txt"), "old", "utf8");

    stubFetch(PACK_MANIFEST, {
      ...PACK_FILES,
      "team.yaml": TEAM.replace("kind: TeamPack", "kind: [broken"),
    });
    await expect(install(dirs, { overwrite: true })).rejects.toThrow(
      /installed pack is invalid/,
    );

    expect(await readFile(path.join(first.dir, "marker.txt"), "utf8")).toBe(
      "old",
    );
    expect(await readdir(dirs.packs)).toEqual(["demo-team"]);
  });
});

describe("legacy install import", () => {
  // Simulate an install made before packs landed in packs/: the pack and its
  // record live directly under workshop/.
  async function installLegacyPack(dirs: { workshop: string }) {
    const dir = path.join(dirs.workshop, "demo-team");
    for (const [name, content] of Object.entries(PACK_FILES)) {
      const target = path.join(dir, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    await writeFile(
      path.join(dir, ".workshop.json"),
      JSON.stringify({
        kind: "pack",
        id: "demo-team",
        name: "Demo Team",
        version: "1.0.0",
        entry: "team.yaml",
        repo: "acme/demo",
        commit: SHA,
        manifestSha256: "b".repeat(64),
        installedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    return dir;
  }

  it("imports a legacy pack into packs/ and keeps the source", async () => {
    const dirs = await makeRoots();
    const legacyDir = await installLegacyPack(dirs);

    const imported = await importInstalledPack({
      dirName: "demo-team",
      root: dirs.workshop,
      packsRoot: dirs.packs,
    });

    expect(imported.dir).toBe(path.join(dirs.packs, "demo-team"));
    expect(existsSync(path.join(legacyDir, "team.yaml"))).toBe(true);
    const loaded = await loadPack(imported.dir);
    expect(loaded.ok).toBe(true);
  });

  it("refuses to import over an existing pack", async () => {
    const dirs = await makeRoots();
    await installLegacyPack(dirs);
    stubFetch(PACK_MANIFEST, PACK_FILES);
    await install(dirs);

    await expect(
      importInstalledPack({
        dirName: "demo-team",
        root: dirs.workshop,
        packsRoot: dirs.packs,
      }),
    ).rejects.toThrow(/already exists/);
  });
});
