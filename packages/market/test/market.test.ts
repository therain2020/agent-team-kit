import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalPayload,
  isCommitSha,
  isSafeRelPath,
  resolveCommit,
  resolveInside,
  scanSecrets,
  verifySignature,
} from "../src";

const SHA = "a".repeat(40);

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("github commit parsing", () => {
  it("accepts a 40-char sha and rejects anything else", async () => {
    expect(isCommitSha(SHA)).toBe(true);
    expect(isCommitSha("abc")).toBe(false);
    expect(isCommitSha("z".repeat(40))).toBe(false);

    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/commits/main")) {
        return json({ sha: SHA });
      }
      if (url.includes("/commits/bad")) {
        return json({ sha: "not-a-sha" });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(resolveCommit("acme/demo", "main")).resolves.toBe(SHA);
    await expect(resolveCommit("acme/demo", "bad")).rejects.toThrow(
      /cannot resolve commit/,
    );
  });
});

describe("signature grading", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();

  it("marks missing, unknown-key and invalid signatures and rejects tampering", () => {
    expect(verifySignature({}, [])).toEqual({
      level: "community",
      signature: "missing",
    });

    const manifest = {
      apiVersion: "agentteam/v1",
      kind: "pack",
      id: "demo",
    };
    const value = sign(
      null,
      canonicalPayload(manifest),
      privateKey as KeyObject,
    ).toString("base64");
    const signed = {
      ...manifest,
      signature: { algorithm: "ed25519", keyId: "k1", value },
    };

    expect(
      verifySignature(signed, [
        { keyId: "k1", publicKey: publicKeyPem, tier: "verified" },
      ]),
    ).toEqual({ level: "verified", signature: "valid", keyId: "k1" });
    expect(
      verifySignature(signed, [
        { keyId: "k1", publicKey: publicKeyPem, tier: "builtin" },
      ]),
    ).toEqual({ level: "builtin", signature: "valid", keyId: "k1" });
    expect(
      verifySignature(signed, [
        { keyId: "other", publicKey: publicKeyPem, tier: "verified" },
      ]),
    ).toEqual({ level: "community", signature: "unknown-key", keyId: "k1" });

    const tampered = { ...manifest, id: "evil", signature: signed.signature };
    expect(
      verifySignature(tampered, [
        { keyId: "k1", publicKey: publicKeyPem, tier: "verified" },
      ]),
    ).toEqual({ level: "community", signature: "invalid", keyId: "k1" });
  });
});

describe("secret scanning", () => {
  it("reports line and label for secret-like content", () => {
    const findings = scanSecrets([
      { file: "source.yaml", content: `token: sk-${"a".repeat(24)}` },
      { file: "clean.yaml", content: "name: ok" },
    ]);
    expect(findings).toEqual([
      { file: "source.yaml", line: 1, label: "API key" },
    ]);
  });
});

describe("path containment", () => {
  it("rejects traversal and absolute paths", () => {
    expect(isSafeRelPath("source.yaml")).toBe(true);
    expect(isSafeRelPath("nested/source.yaml")).toBe(true);
    expect(isSafeRelPath("../evil.yaml")).toBe(false);
    expect(isSafeRelPath("/etc/passwd")).toBe(false);
    expect(() => resolveInside("/tmp/root", "../evil")).toThrow(
      /unsafe market path/,
    );
    expect(resolveInside("/tmp/root", "nested/a.yaml")).toContain("nested");
  });
});
