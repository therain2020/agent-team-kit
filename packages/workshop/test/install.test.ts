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
import { assembleComponents, createPack, loadPack } from "@kit/pack";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importInstalledPack,
  installWorkshop,
  listComponents,
  resolveInstallTarget,
  workshopComponentLibrary,
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

const TEAM = `apiVersion: agentteam/v1
kind: TeamPack
metadata:
  name: demo-team
  version: 1.0.0
  description: Demo team
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

const WORKFLOW = `id: demo-flow
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

const AGENT_MANIFEST = `apiVersion: agentteam/v1
kind: agent
id: echo
name: Echo
version: 1.0.0
entry: agent.md
files:
  - agent.md
permissions:
  code: false
`;

const WORKFLOW_MANIFEST = `apiVersion: agentteam/v1
kind: workflow
id: demo-flow
name: Demo Flow
version: 1.0.0
entry: workflow.yaml
files:
  - workflow.yaml
permissions:
  code: false
`;

const TOOLPACK_MANIFEST = `apiVersion: agentteam/v1
kind: toolpack
id: weather
name: Weather
version: 1.0.0
entry: toolpack.yaml
files:
  - toolpack.yaml
permissions:
  network: true
  code: false
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
    permissions:
      network: true
`;

const SOURCE_MANIFEST = `apiVersion: agentteam/v1
kind: source
id: demo-source
name: Demo Source
version: 1.0.0
entry: source.yaml
files:
  - source.yaml
permissions:
  network: true
  code: false
`;

const SOURCE = `apiVersion: agentteam/source/v1
kind: Source
metadata:
  name: demo-source
  version: 1.0.0
spec:
  type: rss
  request:
    url: https://example.com/feed.xml
`;

const TEMPLATE_MANIFEST = `apiVersion: agentteam/v1
kind: template
id: demo-template
name: Demo Template
version: 1.0.0
entry: template.yaml
files:
  - template.yaml
permissions:
  code: false
`;

const TEMPLATE = `apiVersion: agentteam/v1
kind: TeamTemplate
id: demo-template
name: Demo Template
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

const PIPELINE_MANIFEST = `apiVersion: agentteam/v1
kind: pipeline
id: demo-pipeline
name: Demo Pipeline
version: 1.0.0
entry: pipeline.yaml
files:
  - pipeline.yaml
permissions:
  code: false
`;

const PIPELINE = `apiVersion: agentteam/v1
kind: Pipeline
id: demo-pipeline
version: 1.0.0
graph:
  nodes:
    - id: worker
      type: agent
      inputs: [task]
      outputs: [worker_output]
  edges: []
`;

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface Roots {
  base: string;
  workshop: string;
  packs: string;
  sources: string;
  templates: string;
  components: string;
}

async function makeRoots(): Promise<Roots> {
  const base = await mkdtemp(path.join(tmpdir(), "kit-install-"));
  roots.push(base);
  return {
    base,
    workshop: path.join(base, "workshop"),
    packs: path.join(base, "packs"),
    sources: path.join(base, "sources"),
    templates: path.join(base, "templates"),
    components: path.join(base, "components"),
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
  roots: Roots,
  overrides: { overwrite?: boolean; hostPack?: string } = {},
) {
  return installWorkshop({
    repo: "acme/demo",
    packsRoot: roots.packs,
    sourcesRoot: roots.sources,
    templatesRoot: roots.templates,
    componentsRoot: roots.components,
    acceptThirdParty: true,
    acceptUnsigned: true,
    acceptHighRisk: true,
    ...overrides,
  });
}

describe("workshop install destination by manifest kind", () => {
  it("routes every kind to its own local library", () => {
    const options = {
      packsRoot: path.resolve("kit-root", "packs"),
      sourcesRoot: path.resolve("kit-root", "sources"),
      templatesRoot: path.resolve("kit-root", "templates"),
      componentsRoot: path.resolve("kit-root", "components"),
      hostPack: path.resolve("kit-root", "packs", "host"),
    };

    const pack = resolveInstallTarget(
      { id: "demo-team", kind: "pack" },
      options,
    );
    expect(pack.scope).toBe("packs");
    expect(pack.dir).toBe(path.join(options.packsRoot, "demo-team"));

    const source = resolveInstallTarget(
      { id: "demo-source", kind: "source" },
      options,
    );
    expect(source.scope).toBe("sources");
    expect(source.format).toBe("file");
    expect(source.dir).toBe(path.join(options.sourcesRoot, "demo-source.yaml"));

    const template = resolveInstallTarget(
      { id: "demo-template", kind: "template" },
      options,
    );
    expect(template.scope).toBe("templates");
    expect(template.dir).toBe(
      path.join(options.templatesRoot, "demo-template"),
    );

    const pipeline = resolveInstallTarget(
      { id: "demo-pipeline", kind: "pipeline" },
      options,
    );
    expect(pipeline.scope).toBe("pack-workflows");
    expect(pipeline.dir).toBe(
      path.join(options.hostPack, "workflows", "demo-pipeline.yaml"),
    );

    for (const [kind, id] of [
      ["agent", "echo"],
      ["workflow", "demo-flow"],
      ["toolpack", "weather"],
      ["skillpack", "writer"],
    ] as const) {
      const target = resolveInstallTarget({ id, kind }, options);
      expect(target.scope).toBe("components");
      expect(target.dir).toBe(path.join(options.componentsRoot, kind, id));
    }
  });

  it("refuses pipeline installs without a host pack", () => {
    expect(() =>
      resolveInstallTarget({ id: "p", kind: "pipeline" }, {}),
    ).toThrow(/host pack/);
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

  it("installs source items as sources/<name>.yaml plus metadata", async () => {
    stubFetch(SOURCE_MANIFEST, { "source.yaml": SOURCE });
    const dirs = await makeRoots();

    const installed = await install(dirs);

    expect(installed.scope).toBe("sources");
    expect(installed.dir).toBe(path.join(dirs.sources, "demo-source.yaml"));
    expect(existsSync(installed.dir)).toBe(true);

    const meta = JSON.parse(
      await readFile(path.join(dirs.sources, "demo-source.meta.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(meta).toMatchObject({
      kind: "source",
      id: "demo-source",
      repo: "acme/demo",
      commit: SHA,
      trust: "community",
      secretScan: "passed",
    });
  });

  it("installs template items into templates/<id>", async () => {
    stubFetch(TEMPLATE_MANIFEST, { "template.yaml": TEMPLATE });
    const dirs = await makeRoots();

    const installed = await install(dirs);

    expect(installed.scope).toBe("templates");
    expect(installed.dir).toBe(path.join(dirs.templates, "demo-template"));
    expect(existsSync(path.join(installed.dir, "template.yaml"))).toBe(true);
    expect(existsSync(path.join(installed.dir, ".workshop.json"))).toBe(true);
  });

  it("installs component kinds into components/<kind>/<id>", async () => {
    const dirs = await makeRoots();

    stubFetch(AGENT_MANIFEST, { "agent.md": AGENT });
    const agent = await install(dirs);
    expect(agent.dir).toBe(path.join(dirs.components, "agent", "echo"));

    stubFetch(WORKFLOW_MANIFEST, { "workflow.yaml": WORKFLOW });
    const workflow = await install(dirs);
    expect(workflow.dir).toBe(
      path.join(dirs.components, "workflow", "demo-flow"),
    );

    stubFetch(TOOLPACK_MANIFEST, { "toolpack.yaml": TOOLPACK });
    const toolpack = await install(dirs);
    expect(toolpack.dir).toBe(
      path.join(dirs.components, "toolpack", "weather"),
    );

    const list = await listComponents(dirs.components);
    expect(list.map((entry) => `${entry.kind}/${entry.id}`)).toEqual([
      "agent/echo",
      "toolpack/weather",
      "workflow/demo-flow",
    ]);
    expect(list.every((entry) => entry.valid)).toBe(true);
    const weather = list.find((entry) => entry.id === "weather");
    expect(weather?.provenance?.repo).toBe("acme/demo");
    expect(weather?.provenance?.commit).toBe(SHA);
    expect(weather?.version).toBe("1.0.0");
  });

  it("assembles an installed library component into a host pack", async () => {
    stubFetch(AGENT_MANIFEST, { "agent.md": AGENT });
    const dirs = await makeRoots();
    await install(dirs);
    await createPack({
      root: dirs.packs,
      dirName: "host-team",
      name: "Host Team",
      template: "minimal",
    });
    const host = path.join(dirs.packs, "host-team");

    const result = await assembleComponents(
      { packDir: host, components: [{ kind: "agent", id: "echo" }] },
      workshopComponentLibrary(dirs.components),
    );

    expect(result.bindings).toHaveLength(1);
    const loaded = await loadPack(host);
    if (!loaded.ok) {
      throw new Error(loaded.errors.join("; "));
    }
    expect(loaded.agents.has("echo")).toBe(true);
  });

  it("installs pipeline items into a host pack's workflows and registers them", async () => {
    stubFetch(PIPELINE_MANIFEST, { "pipeline.yaml": PIPELINE });
    const dirs = await makeRoots();
    await createPack({
      root: dirs.packs,
      dirName: "host-team",
      name: "Host Team",
      template: "minimal",
    });
    const host = path.join(dirs.packs, "host-team");

    const installed = await install(dirs, { hostPack: host });

    expect(installed.scope).toBe("pack-workflows");
    expect(installed.dir).toBe(
      path.join(host, "workflows", "demo-pipeline.yaml"),
    );
    const team = await readFile(path.join(host, "team.yaml"), "utf8");
    expect(team).toContain("workflows/demo-pipeline.yaml");
    const loaded = await loadPack(host);
    expect(loaded.ok).toBe(true);
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
  it("leaves nothing behind when pack validation fails", async () => {
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

  it("leaves nothing behind when a component is invalid", async () => {
    stubFetch(TOOLPACK_MANIFEST, {
      "toolpack.yaml": "apiVersion: agentteam/v1\nkind: ToolPack\n",
    });
    const dirs = await makeRoots();

    await expect(install(dirs)).rejects.toThrow(
      /installed toolpack is invalid/,
    );
    expect(existsSync(path.join(dirs.components, "toolpack", "weather"))).toBe(
      false,
    );
  });

  it("rolls a pipeline back when the host pack cannot load it", async () => {
    stubFetch(PIPELINE_MANIFEST, {
      "pipeline.yaml": PIPELINE.replace("id: worker", "id: ghost"),
    });
    const dirs = await makeRoots();
    await createPack({
      root: dirs.packs,
      dirName: "host-team",
      name: "Host Team",
      template: "minimal",
    });
    const host = path.join(dirs.packs, "host-team");
    const before = await readFile(path.join(host, "team.yaml"), "utf8");

    await expect(install(dirs, { hostPack: host })).rejects.toThrow(
      /unknown agent|register/i,
    );

    expect(existsSync(path.join(host, "workflows", "demo-pipeline.yaml"))).toBe(
      false,
    );
    expect(await readFile(path.join(host, "team.yaml"), "utf8")).toBe(before);
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
