import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import { listOps } from "../src/op-log";
import { initStore } from "../src/store";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function localStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-lkg-"));
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

const at = "2026-11-15T00:00:00.000Z";

describe("last-known-good store", () => {
  it("registers, switches, and keeps a superseded history", async () => {
    const store = await localStore();

    const first = await store.lkgService.register({
      workspaceId: "ws-1",
      artifactRefs: [{ artifactId: "art_1", version: 1 }],
      verifier: "alice",
      verifiedAt: at,
      now: at,
    });
    expect(first.changed).toBe(true);
    expect(first.audited).toBe(true);
    expect(first.record).toMatchObject({
      status: "active",
      verifier: "alice",
      verifiedAt: at,
    });

    const second = await store.lkgService.register({
      workspaceId: "ws-1",
      artifactRefs: [{ artifactId: "art_2", version: 1 }],
      verifier: "bob",
      verifiedAt: "2026-11-16T00:00:00.000Z",
      now: "2026-11-16T00:00:00.000Z",
    });
    expect(second.record.supersedes).toBe(first.record.lkgId);
    expect(second.previous.map((record) => record.lkgId)).toEqual([
      first.record.lkgId,
    ]);

    const active = await store.lkg.listActive("ws-1");
    expect(active).toHaveLength(1);
    expect(active[0]?.lkgId).toBe(second.record.lkgId);

    const history = await store.lkg.history("ws-1", "workspace-artifacts");
    expect(history.map((record) => record.status)).toEqual([
      "active",
      "superseded",
    ]);
    expect(await store.lkg.get(first.record.lkgId)).toMatchObject({
      status: "superseded",
      supersededBy: second.record.lkgId,
    });
  });

  it("audits every switch to the op log before and after", async () => {
    const store = await localStore();

    await store.lkgService.register({
      workspaceId: "ws-1",
      artifactRefs: [{ artifactId: "art_1", version: 1 }],
      verifier: "alice",
      verifiedAt: at,
      now: at,
    });
    await store.lkgService.register({
      workspaceId: "ws-1",
      artifactRefs: [{ artifactId: "art_2", version: 1 }],
      verifier: "bob",
      verifiedAt: "2026-11-16T00:00:00.000Z",
      now: "2026-11-16T00:00:00.000Z",
    });

    const ops = await listOps(
      { sql: store.sql },
      { entityKind: "last_known_good" },
    );
    expect(ops.map((op) => op.op)).toEqual(["lkg.register", "lkg.switch"]);
    expect(ops[1]?.payload).toMatchObject({
      verifiedAt: "2026-11-16T00:00:00.000Z",
      verifier: "bob",
    });
  });

  it("derives the 7-day internal-only state when resolving", async () => {
    const store = await localStore();
    await store.lkgService.register({
      workspaceId: "ws-1",
      artifactRefs: [{ artifactId: "art_1", version: 1 }],
      verifier: "alice",
      verifiedAt: at,
      now: at,
    });

    const fresh = await store.lkgService.resolve({
      workspaceId: "ws-1",
      now: "2026-11-22T00:00:00.000Z",
    });
    expect(fresh.verification?.state).toBe("verified");

    const stale = await store.lkgService.resolve({
      workspaceId: "ws-1",
      now: "2026-11-22T00:00:00.001Z",
    });
    expect(stale.verification?.state).toBe("stale");
    expect(stale.verification?.expiresAt).toBe("2026-11-22T00:00:00.000Z");
  });
});
