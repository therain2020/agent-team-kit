import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { workshopManifestSchema } from "@kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import {
  type WorkshopTrustedKey,
  canonicalManifestPayload,
  installWorkshop,
  listComponents,
  previewWorkshop,
  searchWorkshop,
} from "../src";

const SHA = "a".repeat(40);
const roots: string[] = [];

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

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

function manifestText(
  options: {
    code?: boolean;
    network?: boolean;
    filesystem?: string;
    extra?: Record<string, unknown>;
  } = {},
) {
  const manifest: Record<string, unknown> = {
    apiVersion: "agentteam/v1",
    kind: "workflow",
    id: "demo-flow",
    name: "Demo Flow",
    version: "1.0.0",
    description: "A demo workflow",
    entry: "workflows/demo.yaml",
    files: ["workflows/demo.yaml"],
    permissions: {
      code: options.code === true,
      network: options.network === true,
      ...(options.filesystem ? { filesystem: options.filesystem } : {}),
    },
    ...options.extra,
  };
  return stringify(manifest);
}

function signedManifestText(keyId: string) {
  const base = workshopManifestSchema.parse({
    apiVersion: "agentteam/v1",
    kind: "workflow",
    id: "demo-flow",
    name: "Demo Flow",
    version: "1.0.0",
    description: "A demo workflow",
    entry: "workflows/demo.yaml",
    files: ["workflows/demo.yaml"],
    permissions: { code: false, network: false },
  });
  const value = sign(
    null,
    canonicalManifestPayload(base),
    privateKey as KeyObject,
  ).toString("base64");
  return stringify({
    ...base,
    signature: { algorithm: "ed25519", keyId, value },
  });
}

function trustedKey(tier: "builtin" | "verified"): WorkshopTrustedKey[] {
  return [{ keyId: "test-key", publicKey: publicKeyPem, tier }];
}

function stubFetch(
  options: { manifest?: string; files?: Record<string, string> } = {},
) {
  const manifestBody = options.manifest ?? manifestText();
  const files: Record<string, string> = {
    "workflows/demo.yaml": workflow,
    ...options.files,
  };
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
      return text(manifestBody);
    }
    const file = Object.keys(files).find((name) => url.endsWith(`/${name}`));
    if (file) {
      return text(files[file] ?? "");
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

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "kit-workshop-"));
  roots.push(root);
  return root;
}

describe("workshop", () => {
  it("searches repositories, reads their manifest and trust", async () => {
    stubFetch();
    const candidates = await searchWorkshop({ query: "demo", keys: [] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.manifest?.id).toBe("demo-flow");
    expect(candidates[0]?.trust).toEqual({
      level: "community",
      signature: "missing",
    });
  });

  it("previews without executing code", async () => {
    stubFetch();
    const preview = await previewWorkshop({ repo: "acme/demo", keys: [] });
    expect(preview.commit).toBe(SHA);
    expect(preview.entryPreview).toContain("demo-flow");
    expect(preview.trust.level).toBe("community");
    expect(preview.secretFindings).toEqual([]);
  });

  it("installs files at a pinned commit with a record", async () => {
    stubFetch();
    const root = await tempRoot();
    const installed = await installWorkshop({
      repo: "acme/demo",
      componentsRoot: root,
      acceptThirdParty: true,
      acceptUnsigned: true,
      keys: [],
    });
    expect(installed.commit).toBe(SHA);
    expect(installed.files).toEqual(["workflows/demo.yaml"]);
    expect(installed.trust.level).toBe("community");
    expect(
      await readFile(path.join(installed.dir, "workflows/demo.yaml"), "utf8"),
    ).toContain("demo-flow");
    const record = JSON.parse(
      await readFile(path.join(installed.dir, ".workshop.json"), "utf8"),
    ) as {
      commit: string;
      repo: string;
      trust: { level: string };
      secretScan: string;
    };
    expect(record.repo).toBe("acme/demo");
    expect(record.commit).toBe(SHA);
    expect(record.trust.level).toBe("community");
    expect(record.secretScan).toBe("passed");
    const listed = await listComponents(root);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.kind).toBe("workflow");
    expect(listed[0]?.id).toBe("demo-flow");
    expect(listed[0]?.provenance?.repo).toBe("acme/demo");
    expect(listed[0]?.provenance?.commit).toBe(SHA);
  });

  it("requires explicit confirmation for unsigned items", async () => {
    stubFetch();
    const root = await tempRoot();
    await expect(
      installWorkshop({
        repo: "acme/demo",
        componentsRoot: root,
        acceptThirdParty: true,
        keys: [],
      }),
    ).rejects.toThrow("acceptUnsigned");
  });

  it("accepts items signed by a trusted key", async () => {
    stubFetch({ manifest: signedManifestText("test-key") });
    const root = await tempRoot();
    const preview = await previewWorkshop({
      repo: "acme/demo",
      keys: trustedKey("verified"),
    });
    expect(preview.trust).toEqual({
      level: "verified",
      signature: "valid",
      keyId: "test-key",
    });
    const installed = await installWorkshop({
      repo: "acme/demo",
      componentsRoot: root,
      acceptThirdParty: true,
      keys: trustedKey("verified"),
    });
    expect(installed.trust.level).toBe("verified");
  });

  it("marks first-party signing keys as builtin and rejects invalid signatures", async () => {
    stubFetch({ manifest: signedManifestText("test-key") });
    const builtin = await previewWorkshop({
      repo: "acme/demo",
      keys: trustedKey("builtin"),
    });
    expect(builtin.trust.level).toBe("builtin");

    const tampered = signedManifestText("test-key").replace(
      /value: .*/,
      `value: ${Buffer.from("tampered-signature-value").toString("base64")}`,
    );
    stubFetch({ manifest: tampered });
    const invalid = await previewWorkshop({
      repo: "acme/demo",
      keys: trustedKey("verified"),
    });
    expect(invalid.trust).toEqual({
      level: "community",
      signature: "invalid",
      keyId: "test-key",
    });
  });

  it("reports signatures from unknown keys", async () => {
    stubFetch({ manifest: signedManifestText("unknown-key") });
    const preview = await previewWorkshop({
      repo: "acme/demo",
      keys: trustedKey("verified"),
    });
    expect(preview.trust).toEqual({
      level: "community",
      signature: "unknown-key",
      keyId: "unknown-key",
    });
  });

  it("requires explicit code permission", async () => {
    stubFetch({ manifest: manifestText({ code: true }) });
    const root = await tempRoot();
    await expect(
      installWorkshop({
        repo: "acme/demo",
        componentsRoot: root,
        acceptThirdParty: true,
        acceptUnsigned: true,
        acceptHighRisk: true,
        keys: [],
      }),
    ).rejects.toThrow("allowCode");
  });

  it("requires confirmation for high-risk network access", async () => {
    stubFetch({ manifest: manifestText({ network: true }) });
    const root = await tempRoot();
    await expect(
      installWorkshop({
        repo: "acme/demo",
        componentsRoot: root,
        acceptThirdParty: true,
        acceptUnsigned: true,
        keys: [],
      }),
    ).rejects.toThrow("high-risk");

    const installed = await installWorkshop({
      repo: "acme/demo",
      componentsRoot: root,
      acceptThirdParty: true,
      acceptUnsigned: true,
      acceptHighRisk: true,
      keys: [],
    });
    expect(installed.permissions.highRisk.map((entry) => entry.id)).toEqual([
      "network",
    ]);
  });

  it("blocks files that contain secrets", async () => {
    stubFetch({
      files: {
        "workflows/demo.yaml": `${workflow}token: sk-${"a".repeat(24)}`,
      },
    });
    const preview = await previewWorkshop({ repo: "acme/demo", keys: [] });
    expect(preview.secretFindings).toEqual([
      { file: "workflows/demo.yaml", line: 11, label: "API key" },
    ]);
    const root = await tempRoot();
    await expect(
      installWorkshop({
        repo: "acme/demo",
        componentsRoot: root,
        acceptThirdParty: true,
        acceptUnsigned: true,
        keys: [],
      }),
    ).rejects.toThrow("secret-like");
  });

  it("rejects invalid permission declarations", async () => {
    stubFetch({ manifest: manifestText({ filesystem: "everything" }) });
    await expect(
      previewWorkshop({ repo: "acme/demo", keys: [] }),
    ).rejects.toThrow();
  });

  it("rejects oversized files", async () => {
    stubFetch({ files: { "workflows/demo.yaml": "a".repeat(260 * 1024) } });
    await expect(
      previewWorkshop({ repo: "acme/demo", keys: [] }),
    ).rejects.toThrow("256KB");
  });

  it("rejects unsafe manifest paths", async () => {
    stubFetch({
      manifest: manifestText().replace("workflows/demo.yaml", "../evil.yaml"),
    });
    await expect(
      previewWorkshop({ repo: "acme/demo", keys: [] }),
    ).rejects.toThrow();
  });
});
