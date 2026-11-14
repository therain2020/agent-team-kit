import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installWorkshop, previewWorkshop, searchWorkshop } from "../src";

const SHA = "a".repeat(40);
const roots: string[] = [];

const manifest = `apiVersion: agentteam/v1
kind: workflow
id: demo-flow
name: Demo Flow
version: 1.0.0
description: A demo workflow
entry: workflows/demo.yaml
files:
  - workflows/demo.yaml
permissions:
  code: false
`;

const workflow = `id: demo-flow
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

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function stubFetch(
  options: {
    code?: boolean;
    manifest?: string;
    workflow?: string;
    files?: Record<string, string>;
  } = {},
) {
  const manifestText =
    options.manifest ??
    manifest.replace("code: false", `code: ${options.code === true}`);
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/search/repositories")) {
      return json({
        items: [
          {
            full_name: "acme/demo",
            html_url: "https://github.com/acme/demo",
            description: "demo",
            stargazers_count: 3,
            default_branch: "main",
            updated_at: "2026-11-14T00:00:00.000Z",
          },
        ],
      });
    }
    if (url.endsWith("/repos/acme/demo")) {
      return json({ default_branch: "main" });
    }
    if (url.includes("/commits/")) {
      return json({ sha: SHA });
    }
    if (url.endsWith("/workshop.yaml")) {
      return text(manifestText);
    }
    const file = Object.entries(options.files ?? {}).find(([name]) =>
      url.endsWith(`/${name}`),
    );
    if (file) {
      return text(file[1]);
    }
    if (url.endsWith("/workflows/demo.yaml")) {
      return text(options.workflow ?? workflow);
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

const httpToolYaml = `  - name: weather_lookup
    description: Look up weather
    risk: network
    adapter: http
    endpoint: https://api.example.com/weather
    permissions:
      network: true
`;

const mcpToolYaml = `  - name: mcp_lookup
    description: MCP lookup
    risk: network
    adapter: mcp
    endpoint: https://mcp.example.com/sse
    permissions:
      network: true
`;

const commandToolYaml = `  - name: run_script
    description: Run a script
    risk: execute
    adapter: command
    command: [node, script.js]
    permissions:
      filesystem: sandbox
`;

function toolpackYaml(tool: string): string {
  return `apiVersion: agentteam/v1
kind: ToolPack
name: weather
version: 1.0.0
tools:
${tool}`;
}

function toolpackManifest(
  options: { network?: boolean; code?: boolean } = {},
): string {
  return `apiVersion: agentteam/v1
kind: toolpack
id: tool-weather
name: Weather
version: 1.0.0
entry: toolpack.yaml
files:
  - toolpack.yaml
permissions:
  network: ${options.network === true}
  code: ${options.code === true}
`;
}

const skillpackManifest = `apiVersion: agentteam/v1
kind: skillpack
id: skill-writer
name: Writer
version: 1.0.0
entry: skillpack.yaml
files:
  - skillpack.yaml
  - skills/writer/SKILL.md
permissions:
  code: false
`;

const skillpackYaml = `apiVersion: agentteam/v1
kind: SkillPack
name: writer
version: 1.0.0
entry: skills/writer/SKILL.md
files:
  - skills/writer/SKILL.md
  - skills/writer/helper.md
`;

const skillMarkdown = `---
name: writer
description: Write drafts
---

Write clearly.
`;

describe("workshop", () => {
  it("searches repositories and reads their manifest", async () => {
    stubFetch();
    const candidates = await searchWorkshop({ query: "demo" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.manifest?.id).toBe("demo-flow");
  });

  it("previews without executing code", async () => {
    stubFetch();
    const preview = await previewWorkshop({ repo: "acme/demo" });
    expect(preview.commit).toBe(SHA);
    expect(preview.entryPreview).toContain("demo-flow");
  });

  it("installs files at a pinned commit with a record", async () => {
    stubFetch();
    const root = await mkdtemp(path.join(tmpdir(), "kit-workshop-"));
    roots.push(root);
    const installed = await installWorkshop({
      repo: "acme/demo",
      root,
      acceptThirdParty: true,
      acceptUnsigned: true,
    });
    expect(installed.commit).toBe(SHA);
    expect(installed.files).toEqual(["workflows/demo.yaml"]);
    expect(
      await readFile(path.join(installed.dir, "workflows/demo.yaml"), "utf8"),
    ).toContain("demo-flow");
    const record = JSON.parse(
      await readFile(path.join(installed.dir, ".workshop.json"), "utf8"),
    ) as { commit: string; repo: string };
    expect(record.repo).toBe("acme/demo");
    expect(record.commit).toBe(SHA);
  });

  it("requires explicit code permission", async () => {
    stubFetch({ code: true });
    const root = await mkdtemp(path.join(tmpdir(), "kit-workshop-"));
    roots.push(root);
    await expect(
      installWorkshop({
        repo: "acme/demo",
        root,
        acceptThirdParty: true,
      acceptUnsigned: true,
      }),
    ).rejects.toThrow("allowCode");
  });

  it("rejects unsafe manifest paths", async () => {
    stubFetch({
      manifest: manifest.replace("workflows/demo.yaml", "../evil.yaml"),
    });
    await expect(previewWorkshop({ repo: "acme/demo" })).rejects.toThrow();
  });

  it("installs a declarative http toolpack when network is declared", async () => {
    stubFetch({
      manifest: toolpackManifest({ network: true }),
      files: { "toolpack.yaml": toolpackYaml(httpToolYaml) },
    });
    const root = await mkdtemp(path.join(tmpdir(), "kit-workshop-"));
    roots.push(root);
    const installed = await installWorkshop({
      repo: "acme/demo",
      root,
      acceptThirdParty: true,
      acceptUnsigned: true,
    });
    expect(installed.manifest.kind).toBe("toolpack");
  });

  it("registers MCP endpoints through a toolpack", async () => {
    stubFetch({
      manifest: toolpackManifest({ network: true }),
      files: { "toolpack.yaml": toolpackYaml(mcpToolYaml) },
    });
    const root = await mkdtemp(path.join(tmpdir(), "kit-workshop-"));
    roots.push(root);
    const installed = await installWorkshop({
      repo: "acme/demo",
      root,
      acceptThirdParty: true,
      acceptUnsigned: true,
    });
    expect(installed.files).toEqual(["toolpack.yaml"]);
  });

  it("rejects network tools without manifest network permission", async () => {
    stubFetch({
      manifest: toolpackManifest(),
      files: { "toolpack.yaml": toolpackYaml(httpToolYaml) },
    });
    const root = await mkdtemp(path.join(tmpdir(), "kit-workshop-"));
    roots.push(root);
    await expect(
      installWorkshop({
        repo: "acme/demo",
        root,
        acceptThirdParty: true,
      acceptUnsigned: true,
      }),
    ).rejects.toThrow(/permissions\.network/);
  });

  it("rejects command tools without code permission", async () => {
    stubFetch({
      manifest: toolpackManifest(),
      files: { "toolpack.yaml": toolpackYaml(commandToolYaml) },
    });
    const root = await mkdtemp(path.join(tmpdir(), "kit-workshop-"));
    roots.push(root);
    await expect(
      installWorkshop({
        repo: "acme/demo",
        root,
        acceptThirdParty: true,
      acceptUnsigned: true,
      }),
    ).rejects.toThrow(/permissions\.code/);
  });

  it("installs command toolpacks with explicit code consent", async () => {
    stubFetch({
      manifest: toolpackManifest({ code: true }),
      files: { "toolpack.yaml": toolpackYaml(commandToolYaml) },
    });
    const root = await mkdtemp(path.join(tmpdir(), "kit-workshop-"));
    roots.push(root);
    const installed = await installWorkshop({
      repo: "acme/demo",
      root,
      acceptThirdParty: true,
      acceptUnsigned: true,
      allowCode: true,
    });
    expect(installed.manifest.kind).toBe("toolpack");
  });

  it("aborts the install when a file contains a secret", async () => {
    stubFetch({ workflow: `${workflow}\n# ghp_${"a".repeat(24)}` });
    const root = await mkdtemp(path.join(tmpdir(), "kit-workshop-"));
    roots.push(root);
    await expect(
      installWorkshop({
        repo: "acme/demo",
        root,
        acceptThirdParty: true,
      acceptUnsigned: true,
      }),
    ).rejects.toThrow(/secret-like content/);
    expect(existsSync(path.join(root, "demo-flow"))).toBe(false);
  });

  it("rejects skillpack files missing from the manifest", async () => {
    stubFetch({
      manifest: skillpackManifest,
      files: {
        "skillpack.yaml": skillpackYaml,
        "skills/writer/SKILL.md": skillMarkdown,
      },
    });
    const root = await mkdtemp(path.join(tmpdir(), "kit-workshop-"));
    roots.push(root);
    await expect(
      installWorkshop({
        repo: "acme/demo",
        root,
        acceptThirdParty: true,
      acceptUnsigned: true,
      }),
    ).rejects.toThrow(/not listed in the manifest/);
  });
});
