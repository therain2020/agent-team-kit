import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ArtifactVersion, Manifest } from "@kit/core";
import { newId } from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-edges-"));
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
  inputs: { artifactId: string; version: number }[],
) {
  return store.artifactService.publish({
    workspaceId: "default",
    content: new TextEncoder().encode(newId("content")),
    producer: {
      agentId: "echo",
      agentVersion: "1.0.0",
      promptHash: "hash",
      modelId: "stub",
    },
    inputs,
    runId: "run_edges_1",
    stageId: "run_edges_1:stage",
    runMode: "DRY_RUN",
    cost: { currency: "CNY", amount: 0, tokens: 0 },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });
}

async function edgeCount(store: Store): Promise<number> {
  const rows = await store.sql<Array<{ n: number }>>`
    SELECT COUNT(*) AS n FROM artifact_edges
  `;
  return Number(rows[0]?.n ?? 0);
}

function manifestFor(workspaceId = "default"): Manifest {
  const now = new Date().toISOString();
  return {
    manifestId: newId("man"),
    workspaceId,
    producer: {
      agentId: "echo",
      agentVersion: "1.0.0",
      promptHash: "hash",
      modelId: "stub",
    },
    inputs: [],
    runId: "run_edges_1",
    stageId: "run_edges_1:stage",
    runMode: "DRY_RUN",
    cost: { currency: "CNY", amount: 0, tokens: 0 },
    evalRefs: [],
    approvalRefs: [],
    sensitivity: "internal",
    retentionClass: "artifact_365d",
    createdAt: now,
  };
}

describe("artifact edges (sqlite)", () => {
  it("materializes consumed edges and answers reverse lookups", async () => {
    const store = await sqliteStore();

    const a = await publish(store, []);
    const b = await publish(store, [
      { artifactId: a.artifact.artifactId, version: a.artifact.version },
    ]);
    const c = await publish(store, [
      { artifactId: b.artifact.artifactId, version: b.artifact.version },
    ]);

    expect(
      await store.artifactStore.consumersOf(a.artifact.artifactId, 1),
    ).toEqual([{ artifactId: b.artifact.artifactId, version: 1 }]);
    expect(
      await store.artifactStore.consumersOf(b.artifact.artifactId, 1),
    ).toEqual([{ artifactId: c.artifact.artifactId, version: 1 }]);
    expect(
      await store.artifactStore.consumersOf(c.artifact.artifactId, 1),
    ).toEqual([]);

    expect(
      (await store.artifactStore.ancestryOf(c.artifact.artifactId, 1)).map(
        (node) => ({
          artifactId: node.artifactId,
          version: node.version,
          depth: node.depth,
          relation: node.relation,
        }),
      ),
    ).toEqual([
      {
        artifactId: b.artifact.artifactId,
        version: 1,
        depth: 1,
        relation: "consumed",
      },
      {
        artifactId: a.artifact.artifactId,
        version: 1,
        depth: 2,
        relation: "consumed",
      },
    ]);

    // Coverage: every manifest input becomes exactly one edge.
    expect(await edgeCount(store)).toBe(2);
  }, 60_000);

  it("treats duplicate inserts as no-ops", async () => {
    const store = await sqliteStore();

    const a = await publish(store, []);
    const b = await publish(store, [
      { artifactId: a.artifact.artifactId, version: a.artifact.version },
    ]);
    expect(await edgeCount(store)).toBe(1);

    // Re-inserting the same artifact version re-derives the same edge.
    await store.artifactStore.putVersion(b.artifact);
    await store.artifactStore.putVersion(b.artifact);
    expect(await edgeCount(store)).toBe(1);
    expect(
      await store.artifactStore.consumersOf(a.artifact.artifactId, 1),
    ).toEqual([{ artifactId: b.artifact.artifactId, version: 1 }]);
  }, 60_000);

  it("backfills from existing manifests and is idempotent on re-run", async () => {
    const store = await sqliteStore();

    const a = await publish(store, []);
    await publish(store, [
      { artifactId: a.artifact.artifactId, version: a.artifact.version },
    ]);

    await store.sql`DELETE FROM artifact_edges`;
    expect(await edgeCount(store)).toBe(0);

    const first = await store.artifactStore.backfillEdges();
    expect(first).toEqual({ inserted: 1, skipped: 0 });
    expect(await edgeCount(store)).toBe(1);

    const second = await store.artifactStore.backfillEdges();
    expect(second).toEqual({ inserted: 0, skipped: 0 });
    expect(await edgeCount(store)).toBe(1);
  }, 60_000);

  it("records superseded edges from the new version", async () => {
    const store = await sqliteStore();

    const a = await publish(store, []);
    const manifest = manifestFor();
    await store.manifests.put(manifest);
    const now = new Date().toISOString();
    const next: ArtifactVersion = {
      artifactId: a.artifact.artifactId,
      version: 2,
      workspaceId: "default",
      blobId: a.blob.blobId,
      manifestId: manifest.manifestId,
      status: "committed",
      supersedes: `${a.artifact.artifactId}@1`,
      supersededBy: null,
      createdAt: now,
    };
    await store.artifactStore.putVersion(next);

    expect(
      (await store.artifactStore.ancestryOf(a.artifact.artifactId, 2)).map(
        (node) => ({
          artifactId: node.artifactId,
          version: node.version,
          depth: node.depth,
          relation: node.relation,
        }),
      ),
    ).toEqual([
      {
        artifactId: a.artifact.artifactId,
        version: 1,
        depth: 1,
        relation: "superseded",
      },
    ]);
    // Supersession is not consumption.
    expect(
      await store.artifactStore.consumersOf(a.artifact.artifactId, 1),
    ).toEqual([]);

    const backfill = await store.artifactStore.backfillEdges();
    expect(backfill).toEqual({ inserted: 0, skipped: 0 });
  }, 60_000);
});
