import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listOps } from "../src/op-log";
import { withStoreLock } from "../src/locks";
import { initStore } from "../src/store";
import { loadStoreConfig } from "../src/config";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-lock-evidence-"));
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("store lock evidence (S9)", () => {
  it("records acquisition and contention in the op log", async () => {
    const store = await sqliteStore();
    const held = withStoreLock(store, "kit:test:lock", async () => {
      await delay(350);
      return "first";
    });

    await delay(50);
    const second = await withStoreLock(store, "kit:test:lock", async () => {
      return "second";
    });
    const first = await held;

    expect(first).toBe("first");
    expect(second).toBeNull();

    const ops = await listOps(store, { limit: 50 });
    const kinds = ops.map((op) => op.op);
    expect(kinds).toContain("lock.acquired");
    expect(kinds).toContain("lock.contended");
    const contended = ops.find((op) => op.op === "lock.contended");
    expect(contended?.entityKind).toBe("store_lock");
    expect(contended?.entityId).toBe("kit:test:lock");
  });
});
