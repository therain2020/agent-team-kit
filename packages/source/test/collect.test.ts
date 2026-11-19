import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CollectOptions,
  type SourceFetchOutcome,
  type SourceFetcher,
  canonicalItemContent,
  captureKeyForItem,
  collectOnce,
  contentHashForItem,
} from "../src/index";
import type { RawSourceItem } from "../src/types";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-collect-"));
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

const hnItems: RawSourceItem[] = [
  {
    source: "hn",
    sourceId: "hn:1",
    title: "First story",
    url: "https://example.com/a",
    publishedAt: "2026-11-19T00:00:00.000Z",
  },
  {
    source: "hn",
    sourceId: "hn:2",
    title: "Second story",
    url: "https://example.com/b",
  },
];

function okFetcher(items: RawSourceItem[]): SourceFetcher {
  return async (sourceId): Promise<SourceFetchOutcome> => ({
    sourceId,
    ok: true,
    fetchedAt,
    latencyMs: 12,
    items,
  });
}

function failingFetcher(message: string): SourceFetcher {
  return async (sourceId): Promise<SourceFetchOutcome> => ({
    sourceId,
    ok: false,
    fetchedAt,
    latencyMs: 4,
    items: [],
    error: message,
  });
}

describe("capture identity", () => {
  it("is stable per source and item, and changes across either", () => {
    const [first] = hnItems;
    if (!first) {
      throw new Error("fixture missing");
    }
    expect(captureKeyForItem(first, "hn")).toBe(captureKeyForItem(first, "hn"));
    expect(captureKeyForItem(first, "hn")).not.toBe(
      captureKeyForItem(first, "other"),
    );
    expect(captureKeyForItem(first, "hn")).not.toBe(
      captureKeyForItem(hnItems[1] as RawSourceItem, "hn"),
    );
    expect(contentHashForItem(first)).toBe(contentHashForItem(first));
    expect(canonicalItemContent(first)).toContain("hn:1");
  });
});

describe("collectOnce (sqlite)", () => {
  it("creates events once and treats a repeat fetch as duplicates", async () => {
    const store = await sqliteStore();

    const first = await collectOnce(store, {
      sources: ["hn"],
      fetcher: okFetcher(hnItems),
      clock: () => new Date(fetchedAt),
    });
    expect(first.eventsCreated).toBe(2);
    expect(first.duplicates).toBe(0);
    expect(first.failures).toBe(0);
    expect(first.sources[0]?.eventsCreated).toBe(2);

    const second = await collectOnce(store, {
      sources: ["hn"],
      fetcher: okFetcher(hnItems),
      clock: () => new Date(fetchedAt),
    });
    expect(second.eventsCreated).toBe(0);
    expect(second.duplicates).toBe(2);

    const events = await store.information.listEvents();
    expect(events).toHaveLength(2);
    expect(events.every((row) => row.eventType === "information.item")).toBe(
      true,
    );
    expect(events[0]?.sourceId).toBe("hn");

    const health = await store.information.getSourceHealth("default", "hn");
    expect(health).toMatchObject({
      runs: 2,
      successes: 2,
      failures: 0,
      itemsCollected: 4,
      eventsCreated: 2,
    });
  });

  it("degrades after consecutive failures and records the transition", async () => {
    const store = await sqliteStore();
    const options: CollectOptions = {
      sources: ["hn"],
      failureThreshold: 2,
      fetcher: failingFetcher("network down"),
      clock: () => new Date(fetchedAt),
    };

    const first = await collectOnce(store, options);
    expect(first.failures).toBe(1);
    expect(first.degradationEntered).toBe(false);
    expect(
      (await store.information.getSourceHealth("default", "hn"))?.degraded,
    ).toBe(false);

    const second = await collectOnce(store, options);
    expect(second.failures).toBe(1);
    expect(second.degradationEntered).toBe(true);
    expect(second.sources[0]?.degraded).toBe(true);

    const mode = await store.degradation.get("workspace", "default");
    expect(mode?.status).toBe("active");
    expect(mode?.triggers[0]?.dependencyId).toBe("source_api");

    const audit = await store.degradation.listAudit();
    expect(audit.some((row) => row.action === "enter")).toBe(true);

    // A third failure never clobbers the live degradation; it records a block.
    const third = await collectOnce(store, options);
    expect(third.degradationEntered).toBe(false);
    const audits = await store.degradation.listAudit();
    expect(audits.some((row) => row.action === "blocked")).toBe(true);
    expect(await store.degradation.listActive()).toHaveLength(1);
  });

  it("recovers source health after a success following failures", async () => {
    const store = await sqliteStore();
    await collectOnce(store, {
      sources: ["hn"],
      failureThreshold: 5,
      fetcher: failingFetcher("flaky"),
      clock: () => new Date(fetchedAt),
    });
    await collectOnce(store, {
      sources: ["hn"],
      fetcher: okFetcher(hnItems),
      clock: () => new Date(fetchedAt),
    });

    const health = await store.information.getSourceHealth("default", "hn");
    expect(health).toMatchObject({
      runs: 2,
      failures: 1,
      successes: 1,
      consecutiveFailures: 0,
      degraded: false,
    });
  });
});
