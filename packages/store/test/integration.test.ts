import path from "node:path";
import { newId } from "@kit/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initStore, withAdvisoryLock } from "../src/index";

process.env.KIT_BLOB_BACKEND ??= "fs";
process.env.KIT_BLOB_ROOT = path.resolve(".tmp/blobs-test", String(Date.now()));

const enabled = process.env.KIT_INTEGRATION === "1";

describe.skipIf(!enabled)("store integration", () => {
  let store: Awaited<ReturnType<typeof initStore>>;

  it("allows only one holder of an advisory lock", async () => {
    const key = `kit:test:${newId("t")}`;
    const events: string[] = [];
    const first = withAdvisoryLock(store.sql, key, async () => {
      events.push("first");
      await new Promise((resolve) => setTimeout(resolve, 200));
      return "first";
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await withAdvisoryLock(store.sql, key, async () => {
      events.push("second");
      return "second";
    });
    expect(second).toBeNull();
    expect(await first).toBe("first");
    expect(events).toEqual(["first"]);
  });

  beforeAll(async () => {
    store = await initStore();
  });

  afterAll(async () => {
    await store?.sql.end();
  });

  it("keeps two artifact identities over one blob", async () => {
    const workspaceId = `ws_${newId("t")}`;
    const content = new TextEncoder().encode("same-content");

    const base = {
      workspaceId,
      content,
      producer: {
        agentId: "echo",
        agentVersion: "1.0.0",
        promptHash: "sha256:abc",
        modelId: "deepseek-flash",
      },
      inputs: [],
      runMode: "DRY_RUN" as const,
      cost: { currency: "CNY" as const, amount: 0, tokens: 0 },
      sensitivity: "internal" as const,
      retentionClass: "artifact_365d",
    };

    const runA = newId("run");
    const runB = newId("run");

    const first = await store.artifactService.publish({
      ...base,
      runId: runA,
      stageId: newId("stg"),
    });
    const second = await store.artifactService.publish({
      ...base,
      runId: runB,
      stageId: newId("stg"),
    });

    expect(first.artifact.artifactId).not.toBe(second.artifact.artifactId);
    expect(first.blob.blobId).toBe(second.blob.blobId);
    expect(first.manifest.manifestId).not.toBe(second.manifest.manifestId);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);

    const byRunA = await store.artifactStore.listByRun(runA);
    const byRunB = await store.artifactStore.listByRun(runB);
    expect(byRunA).toHaveLength(1);
    expect(byRunB).toHaveLength(1);

    const stored = await store.blobClient.get(first.blob.storageKey);
    expect(new TextDecoder().decode(stored)).toBe("same-content");
  });

  it("dedupes events by idempotency key", async () => {
    const workspaceId = `ws_${newId("t")}`;
    const now = new Date().toISOString();
    const event = {
      eventId: newId("evt"),
      type: "demo.event.received",
      schemaVersion: "1.0" as const,
      occurredAt: now,
      receivedAt: now,
      workspaceId,
      idempotencyKey: newId("idem"),
      traceId: newId("trc"),
      payloadRef: "memory://test",
    };

    expect((await store.events.insert(event)).inserted).toBe(true);
    expect((await store.events.insert(event)).inserted).toBe(false);

    const found = await store.events.findByIdempotencyKey(event.idempotencyKey);
    expect(found?.eventId).toBe(event.eventId);
    expect(found?.workspaceId).toBe(workspaceId);
  });
});
