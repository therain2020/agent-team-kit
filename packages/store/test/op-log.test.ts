import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import { ensureSchema } from "../src/migrate";
import { appendOp, findOpByKey, listOps } from "../src/op-log";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-op-log-"));
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

function entry(overrides: Partial<Parameters<typeof appendOp>[1]> = {}) {
  return {
    workspaceId: "default",
    entityKind: "run",
    entityId: "run_1",
    op: "run.status",
    actor: "test",
    origin: "system" as const,
    ...overrides,
  };
}

describe("op log (sqlite)", () => {
  it("assigns strictly increasing seq values", async () => {
    const store = await sqliteStore();
    const first = await appendOp(store, entry());
    const second = await appendOp(store, entry({ entityId: "run_2" }));
    const third = await appendOp(store, entry({ entityId: "run_3" }));

    expect(first.seq).toBeGreaterThan(0);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(third.seq).toBeGreaterThan(second.seq);

    const listed = await listOps(store);
    expect(listed.map((row) => row.seq)).toEqual([
      first.seq,
      second.seq,
      third.seq,
    ]);
  });

  it("returns the first row for a repeated idempotency key", async () => {
    const store = await sqliteStore();
    const first = await appendOp(
      store,
      entry({ idempotencyKey: "budget.reserve:brs_1" }),
    );
    const second = await appendOp(
      store,
      entry({
        idempotencyKey: "budget.reserve:brs_1",
        entityKind: "budget_reservation",
        entityId: "brs_1",
      }),
    );

    expect(second.seq).toBe(first.seq);
    expect(second.opId).toBe(first.opId);
    expect(second.entityKind).toBe("run");
    await expect(listOps(store)).resolves.toHaveLength(1);

    // The same key in another workspace is an independent op.
    await appendOp(
      store,
      entry({ workspaceId: "other", idempotencyKey: "budget.reserve:brs_1" }),
    );
    await expect(listOps(store)).resolves.toHaveLength(2);
  });

  it("keys are nullable and unkeyed appends never collide", async () => {
    const store = await sqliteStore();
    const first = await appendOp(store, entry());
    const second = await appendOp(store, entry());
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(first.idempotencyKey).toBeNull();
    await expect(listOps(store)).resolves.toHaveLength(2);
  });

  it("round-trips the payload and metadata", async () => {
    const store = await sqliteStore();
    const payload = {
      nested: { amount: 12, tags: ["a", "b"] },
      reason: "budget reached",
      ok: true,
    };
    const created = await appendOp(
      store,
      entry({
        entityKind: "artifact",
        entityId: "art_1",
        op: "artifact.commit",
        actor: "writer",
        origin: "agent",
        payload,
      }),
    );

    expect(created.payload).toEqual(payload);
    const [listed] = await listOps(store);
    expect(listed).toMatchObject({
      workspaceId: "default",
      entityKind: "artifact",
      entityId: "art_1",
      op: "artifact.commit",
      actor: "writer",
      origin: "agent",
    });
    expect(listed?.payload).toEqual(payload);
  });

  it("filters and paginates by cursor, entity and workspace", async () => {
    const store = await sqliteStore();
    const a = await appendOp(store, entry({ entityId: "run_a" }));
    const b = await appendOp(
      store,
      entry({ entityId: "run_b", op: "run.pause" }),
    );
    const c = await appendOp(
      store,
      entry({
        workspaceId: "ws2",
        entityKind: "artifact",
        entityId: "art_1",
      }),
    );

    const page1 = await listOps(store, { limit: 2 });
    expect(page1.map((row) => row.seq)).toEqual([a.seq, b.seq]);

    const page2 = await listOps(store, { after: page1[1]?.seq, limit: 2 });
    expect(page2.map((row) => row.seq)).toEqual([c.seq]);

    await expect(
      listOps(store, { entityKind: "artifact" }),
    ).resolves.toHaveLength(1);
    await expect(listOps(store, { entityId: "run_b" })).resolves.toHaveLength(
      1,
    );
    await expect(listOps(store, { workspaceId: "ws2" })).resolves.toHaveLength(
      1,
    );
    await expect(
      listOps(store, { workspaceId: "default" }),
    ).resolves.toHaveLength(2);
  });

  it("finds an op by idempotency key", async () => {
    const store = await sqliteStore();
    await appendOp(store, entry({ idempotencyKey: "run.create:run_1" }));
    const found = await findOpByKey(store, "default", "run.create:run_1");
    expect(found).toMatchObject({
      entityId: "run_1",
      idempotencyKey: "run.create:run_1",
    });
    await expect(findOpByKey(store, "default", "missing")).resolves.toBeNull();
  });

  it("re-runs ensureSchema on an existing database without dropping ops", async () => {
    const store = await sqliteStore();
    const first = await appendOp(store, entry({ idempotencyKey: "op.one" }));

    await ensureSchema(store.exec, store.driver);
    await ensureSchema(store.exec, store.driver);

    const listed = await listOps(store);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.seq).toBe(first.seq);

    const second = await appendOp(store, entry({ idempotencyKey: "op.two" }));
    expect(second.seq).toBeGreaterThan(first.seq);
  });
});
