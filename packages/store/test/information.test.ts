import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildInformationEvent } from "@kit/core";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-information-"));
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

const fetchedAt = "2026-11-20T00:00:00.000Z";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return buildInformationEvent({
    workspaceId: "default",
    sourceId: "hn",
    captureKey: "cap-1",
    itemRef: "hn:1",
    contentRef: "information-capture:cap-1",
    fetchedAt,
    ...overrides,
  });
}

describe("information store (sqlite)", () => {
  it("keeps raw captures immutable under a repeated capture_key", async () => {
    const store = await sqliteStore();
    const first = await store.information.recordCapture({
      captureKey: "cap-1",
      sourceId: "hn",
      fetchedAt,
      contentRef: "information-capture:cap-1",
      contentHash: "hash-1",
      content: '{"title":"first"}',
    });
    const second = await store.information.recordCapture({
      captureKey: "cap-1",
      sourceId: "hn",
      fetchedAt,
      contentRef: "information-capture:cap-1",
      contentHash: "hash-2",
      content: '{"title":"changed"}',
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.capture.content).toBe('{"title":"first"}');
    expect(second.capture.contentHash).toBe("hash-1");
  });

  it("dedupes events by workspace and dedupe key", async () => {
    const store = await sqliteStore();
    const first = await store.information.appendEvent({
      event: makeEvent({ eventId: "inf_first" }),
      title: "First",
      url: "https://example.com/a",
    });
    const second = await store.information.appendEvent({
      event: makeEvent({ eventId: "inf_again" }),
      title: "Again",
      url: "https://example.com/a",
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.event.eventId).toBe("inf_first");
    expect(second.event.title).toBe("First");

    const listed = await store.information.listEvents();
    expect(listed).toHaveLength(1);
    expect(await store.information.isSeen("default", "capture:cap-1")).toBe(
      true,
    );
    expect(await store.information.isSeen("default", "capture:cap-2")).toBe(
      false,
    );

    // The same dedupe key in another workspace is an independent event.
    const other = await store.information.appendEvent({
      workspaceId: "other",
      event: makeEvent({ eventId: "inf_other", workspaceId: "other" }),
    });
    expect(other.inserted).toBe(true);
    expect(
      await store.information.listEvents({ workspaceId: "other" }),
    ).toHaveLength(1);
  });

  it("queries events by source and stays newest-first", async () => {
    const store = await sqliteStore();
    await store.information.appendEvent({
      event: makeEvent({
        eventId: "inf_hn",
        sourceId: "hn",
        captureKey: "cap-hn",
      }),
      title: "HN",
      url: "https://example.com/hn",
    });
    await store.information.appendEvent({
      event: makeEvent({
        eventId: "inf_arxiv",
        sourceId: "arxiv",
        captureKey: "cap-arxiv",
        itemRef: "arxiv:1",
      }),
      title: "Arxiv",
      url: "https://example.com/arxiv",
    });

    const hnOnly = await store.information.listEvents({ sourceId: "hn" });
    expect(hnOnly.map((row) => row.eventId)).toEqual(["inf_hn"]);
    expect(hnOnly[0]?.payload.dedupeKey).toBe("capture:cap-hn");
  });

  it("accumulates source health and degrades on consecutive failures", async () => {
    const store = await sqliteStore();
    const base = {
      workspaceId: "default",
      sourceId: "hn",
      latencyMs: 40,
      failureThreshold: 2,
    };

    const firstFail = await store.information.recordSourceRun({
      ...base,
      ok: false,
      error: "boom",
    });
    expect(firstFail.consecutiveFailures).toBe(1);
    expect(firstFail.degraded).toBe(false);
    expect(firstFail.lastError).toBe("boom");

    const secondFail = await store.information.recordSourceRun({
      ...base,
      ok: false,
      error: "boom again",
    });
    expect(secondFail.consecutiveFailures).toBe(2);
    expect(secondFail.degraded).toBe(true);
    expect(secondFail.failures).toBe(2);

    const success = await store.information.recordSourceRun({
      ...base,
      ok: true,
      items: 3,
      events: 2,
      costCnyMicro: 100,
    });
    expect(success.consecutiveFailures).toBe(0);
    expect(success.degraded).toBe(false);
    expect(success.successes).toBe(1);
    expect(success.itemsCollected).toBe(3);
    expect(success.eventsCreated).toBe(2);
    expect(success.totalCostCnyMicro).toBe(100);
    expect(success.lastLatencyMs).toBe(40);
    expect(success.lastError).toBe("boom again");

    const health = await store.information.listSourceHealth();
    expect(health).toHaveLength(1);
    expect(health[0]?.runs).toBe(3);
  });

  it("re-runs ensureSchema without losing information rows", async () => {
    const store = await sqliteStore();
    await store.information.recordCapture({
      captureKey: "cap-keep",
      sourceId: "hn",
      fetchedAt,
      contentRef: "ref",
      contentHash: "hash",
      content: "{}",
    });
    const appended = await store.information.appendEvent({
      event: makeEvent(),
    });

    // initStore → ensureSchema runs again on the same file when reopened.
    const reopened = await initStore(store.config);
    closers.push(() => reopened.close());
    expect(await reopened.information.listEvents()).toHaveLength(1);
    expect(
      await reopened.information.getEvent("default", appended.event.eventId),
    ).not.toBeNull();
  });
});
