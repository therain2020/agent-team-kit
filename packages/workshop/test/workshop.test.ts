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

function stubFetch(options: { code?: boolean; manifest?: string } = {}) {
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
    if (url.endsWith("/workflows/demo.yaml")) {
      return text(workflow);
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
      }),
    ).rejects.toThrow("allowCode");
  });

  it("rejects unsafe manifest paths", async () => {
    stubFetch({
      manifest: manifest.replace("workflows/demo.yaml", "../evil.yaml"),
    });
    await expect(previewWorkshop({ repo: "acme/demo" })).rejects.toThrow();
  });
});
