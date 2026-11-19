import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  verifyArtifactVersion,
  verifyRunArtifacts,
} from "../src/artifact-integrity";
import { loadStoreConfig } from "../src/config";
import { initStore } from "../src/store";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function sqliteStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-integrity-"));
  dirs.push(dir);
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: dir,
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
  closers.push(() => store.close());
  return store;
}

type Store = Awaited<ReturnType<typeof sqliteStore>>;

async function publish(
  store: Store,
  runId: string,
  stageId: string,
  content: string,
  inputs: { artifactId: string; version: number }[] = [],
) {
  return store.artifactService.publish({
    workspaceId: "default",
    content: new TextEncoder().encode(content),
    producer: {
      agentId: "echo",
      agentVersion: "1.0.0",
      promptHash: "hash",
      modelId: "stub",
    },
    inputs,
    runId,
    stageId,
    runMode: "DRY_RUN",
    cost: { currency: "CNY", amount: 0, tokens: 0 },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });
}

describe("ArtifactVersion integrity verification (61 §3.5)", () => {
  it("passes for freshly published artifacts and checks every version", async () => {
    const store = await sqliteStore();
    const runId = "run_integrity_ok";
    const first = await publish(store, runId, `${runId}:a`, "alpha");
    await publish(store, runId, `${runId}:b`, "beta", [
      { artifactId: first.artifact.artifactId, version: 1 },
    ]);

    const report = await verifyRunArtifacts(store, runId);

    expect(report.ok).toBe(true);
    expect(report.checked).toBe(2);
    expect(report.failures).toHaveLength(0);
    expect(report.checks.every((check) => check.sha256?.length === 64)).toBe(
      true,
    );

    const single = await verifyArtifactVersion(
      store,
      first.artifact.artifactId,
      1,
    );
    expect(single.ok).toBe(true);
    expect(single.problems).toEqual([]);
  });

  it("treats a run with no artifacts as a vacuous pass", async () => {
    const store = await sqliteStore();
    const report = await verifyRunArtifacts(store, "run_without_artifacts");
    expect(report).toMatchObject({ ok: true, checked: 0, failures: [] });
  });

  it("detects tampered blob content by sha256 and size", async () => {
    const store = await sqliteStore();
    const runId = "run_integrity_tampered";
    const published = await publish(store, runId, `${runId}:a`, "original");

    const blobPath = path.join(
      store.config.blobRoot,
      published.blob.storageKey,
    );
    await writeFile(blobPath, new TextEncoder().encode("tampered!"));

    const report = await verifyRunArtifacts(store, runId);
    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    const codes = report.failures[0]?.problems.map((problem) => problem.code);
    expect(codes).toContain("blob_sha256_mismatch");
    expect(codes).toContain("blob_size_mismatch");
  });

  it("reports a missing blob as a verification failure", async () => {
    const store = await sqliteStore();
    const runId = "run_integrity_missing_blob";
    const published = await publish(store, runId, `${runId}:a`, "content");
    await rm(path.join(store.config.blobRoot, published.blob.storageKey));

    const report = await verifyRunArtifacts(store, runId);
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.problems[0]?.code).toBe("blob_unreadable");
  });
});
