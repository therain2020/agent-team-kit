import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalPayload } from "@kit/market";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify } from "yaml";
import {
  type SourceDefinition,
  installSource,
  loadInstalledSource,
  sourceDefinitionSchema,
} from "../src";

const SHA = "a".repeat(40);
const roots: string[] = [];

const sourceYaml = `apiVersion: agentteam/source/v1
kind: Source
metadata:
  name: demo-feed
  version: 1.0.0
  description: Demo feed
  homepage: https://example.com
spec:
  type: rss
  request:
    url: https://example.com/feed.xml
`;

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots
      .splice(0)
      .map((root) =>
        rm(root, { recursive: true, force: true }).catch(() => undefined),
      ),
  );
});

function parseSource(raw: string): SourceDefinition {
  const parsed = sourceDefinitionSchema.safeParse(parseYaml(raw));
  if (!parsed.success) {
    throw new Error("test source manifest is invalid");
  }
  return parsed.data;
}

function signDefinition(
  definition: SourceDefinition,
  privateKey: KeyObject,
  keyId = "k1",
): string {
  const value = sign(null, canonicalPayload(definition), privateKey).toString(
    "base64",
  );
  return stringify({
    ...definition,
    signature: { algorithm: "ed25519", keyId, value },
  });
}

function stubFetch(manifestText: string, file = "source.yaml") {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/repos/acme/demo")) {
      return json({ default_branch: "main" });
    }
    if (url.includes("/commits/")) {
      return json({ sha: SHA });
    }
    if (url.endsWith(`/${file}`)) {
      return new Response(manifestText, { status: 200 });
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

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kit-source-"));
  roots.push(root);
  return root;
}

function noEndpoint() {
  return async () => undefined;
}

describe("source install through the market kernel", () => {
  it("installs at a pinned commit and writes an aligned record", async () => {
    stubFetch(sourceYaml);
    const root = await tempRoot();

    const installed = await installSource({
      repo: "acme/demo",
      root,
      acceptThirdParty: true,
      keys: [],
      validateEndpoint: noEndpoint(),
    });

    expect(installed.meta.commit).toBe(SHA);
    expect(installed.meta.trust).toBe("community");
    expect(installed.meta.trustDetail).toEqual({
      level: "community",
      signature: "missing",
    });
    expect(installed.meta.secretScan).toBe("passed");
    expect(installed.meta.kind).toBe("source");
    expect(installed.meta.files?.["source.yaml"]).toHaveLength(64);
    expect(await readFile(path.join(root, "demo-feed.yaml"), "utf8")).toContain(
      "demo-feed",
    );
  });

  it("records an invalid signature as community but installs with consent", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const { publicKey: otherPublicKey } = generateKeyPairSync("ed25519");
    stubFetch(signDefinition(parseSource(sourceYaml), privateKey as KeyObject));
    const root = await tempRoot();

    const installed = await installSource({
      repo: "acme/demo",
      root,
      acceptThirdParty: true,
      keys: [
        {
          keyId: "k1",
          publicKey: otherPublicKey
            .export({ type: "spki", format: "pem" })
            .toString(),
          tier: "verified",
        },
      ],
      validateEndpoint: noEndpoint(),
    });

    expect(installed.meta.trust).toBe("community");
    expect(installed.meta.trustDetail?.signature).toBe("invalid");
  });

  it("accepts a source signed by a trusted key as verified", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    stubFetch(signDefinition(parseSource(sourceYaml), privateKey as KeyObject));
    const root = await tempRoot();

    const installed = await installSource({
      repo: "acme/demo",
      root,
      acceptThirdParty: true,
      keys: [
        {
          keyId: "k1",
          publicKey: publicKey
            .export({ type: "spki", format: "pem" })
            .toString(),
          tier: "verified",
        },
      ],
      validateEndpoint: noEndpoint(),
    });

    expect(installed.meta.trust).toBe("verified");
    expect(installed.meta.trustDetail).toEqual({
      level: "verified",
      signature: "valid",
      keyId: "k1",
    });
  });

  it("blocks a manifest that contains secret-like content", async () => {
    stubFetch(`${sourceYaml}\n# token: sk-${"a".repeat(24)}\n`);
    const root = await tempRoot();

    await expect(
      installSource({
        repo: "acme/demo",
        root,
        acceptThirdParty: true,
        keys: [],
        validateEndpoint: noEndpoint(),
      }),
    ).rejects.toThrow(/secret-like content/);
    expect(existsSync(path.join(root, "demo-feed.yaml"))).toBe(false);
  });

  it("rejects a manifest path that escapes the repository", async () => {
    stubFetch(sourceYaml);
    const root = await tempRoot();

    await expect(
      installSource({
        repo: "acme/demo",
        root,
        acceptThirdParty: true,
        file: "../evil.yaml",
        keys: [],
        validateEndpoint: noEndpoint(),
      }),
    ).rejects.toThrow(/invalid manifest path/);
  });

  it("loads a legacy sources/ record with a string trust", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "legacy.yaml"), sourceYaml, "utf8");
    await writeFile(
      path.join(root, "legacy.meta.json"),
      JSON.stringify({
        name: "legacy",
        repo: "acme/legacy",
        commit: SHA,
        manifestSha256: "b".repeat(64),
        installedAt: new Date(0).toISOString(),
        trust: "third-party",
      }),
      "utf8",
    );

    const loaded = await loadInstalledSource("legacy", root);
    expect(loaded?.meta.repo).toBe("acme/legacy");
    expect(loaded?.meta.trust).toBe("third-party");
  });
});
