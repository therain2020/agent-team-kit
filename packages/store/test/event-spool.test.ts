import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import type { EventSpoolRecord } from "../src/event-spool";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-event-spool-"));
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

function record(
  eventId: string,
  overrides: Partial<EventSpoolRecord> = {},
): EventSpoolRecord {
  return {
    eventId,
    subject: "kit.events.>",
    priority: "P2",
    data: new TextEncoder().encode(`payload-${eventId}`),
    workspaceId: "default",
    enqueuedAt: "2026-11-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("event spool (sqlite)", () => {
  it("persists pending events in insertion order and round-trips bytes", async () => {
    const store = await sqliteStore();

    expect(await store.spool.append(record("e1"))).toBe(true);
    expect(
      await store.spool.append(
        record("e2", {
          priority: "P0",
          data: new Uint8Array([0, 1, 2, 255]),
        }),
      ),
    ).toBe(true);

    const pending = await store.spool.listPending();
    expect(pending.map((entry) => entry.eventId)).toEqual(["e1", "e2"]);
    expect(pending[1]?.priority).toBe("P0");
    expect([...(pending[1]?.data ?? [])]).toEqual([0, 1, 2, 255]);
  });

  it("dedupes appends by event_id across pending and delivered rows", async () => {
    const store = await sqliteStore();

    expect(await store.spool.append(record("e1"))).toBe(true);
    expect(await store.spool.append(record("e1"))).toBe(false);
    expect(await store.spool.has("e1")).toBe(true);
    expect(await store.spool.isDelivered("e1")).toBe(false);

    expect(
      await store.spool.markDelivered("e1", "2026-11-15T00:01:00.000Z"),
    ).toBe(true);
    await store.spool.remove(["e1"]);

    expect(await store.spool.isDelivered("e1")).toBe(true);
    expect(await store.spool.has("e1")).toBe(true);
    expect(await store.spool.append(record("e1"))).toBe(false);
    expect(await store.spool.listPending()).toHaveLength(0);
  });

  it("reports markDelivered/remove misses without throwing", async () => {
    const store = await sqliteStore();
    expect(
      await store.spool.markDelivered("missing", "2026-11-15T00:01:00.000Z"),
    ).toBe(false);
    expect(await store.spool.remove(["missing"])).toBe(0);
    expect(await store.spool.isDelivered("missing")).toBe(false);
  });

  it("removes only pending rows and bounds delivered history", async () => {
    const store = await sqliteStore();
    await store.spool.append(record("old"));
    await store.spool.append(record("new"));
    await store.spool.markDelivered("old", "2026-11-01T00:00:00.000Z");

    expect(await store.spool.remove(["old"])).toBe(0);
    expect(await store.spool.remove(["new"])).toBe(1);
    expect(await store.spool.listPending()).toHaveLength(0);

    expect(await store.spool.pruneDelivered("2026-11-10T00:00:00.000Z")).toBe(
      1,
    );
    expect(await store.spool.isDelivered("old")).toBe(false);
  });
});
