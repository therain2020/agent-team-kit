import type { EventEnvelope } from "@kit/core";
import { NatsEventQueue } from "@kit/queue";
import { initStore } from "@kit/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventIngestor, type IngestResult } from "../src/ingestor";

const enabled = process.env.KIT_INTEGRATION === "1";
const runId = Date.now().toString();
const stream = `KIT_INGEST_${runId}`;
const subject = `kit.ingest.${runId}.events`;

const event: EventEnvelope = {
  eventId: `evt_${runId}`,
  type: "demo.event.received",
  schemaVersion: "1.0",
  occurredAt: new Date().toISOString(),
  receivedAt: new Date().toISOString(),
  workspaceId: `ws_${runId}`,
  idempotencyKey: `idem_${runId}`,
  traceId: `trc_${runId}`,
  payloadRef: "memory://test",
};

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for ingestion");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!enabled)("ingest integration", () => {
  let store: Awaited<ReturnType<typeof initStore>>;
  let queue: NatsEventQueue;
  let stop: (() => Promise<void>) | undefined;
  const results: IngestResult[] = [];

  beforeAll(async () => {
    store = await initStore();
    queue = new NatsEventQueue({
      url: process.env.KIT_NATS_URL ?? "nats://localhost:4222",
      stream,
      subjects: [subject],
    });
    await queue.connect();

    const ingestor = new EventIngestor(store.events);
    stop = await queue.subscribe(subject, async (message) => {
      results.push(await ingestor.handle(message.data));
    });
  });

  afterAll(async () => {
    await stop?.();
    await queue.destroy();
    await store.close();
  });

  it("ingests once and reports the duplicate", async () => {
    const payload = new TextEncoder().encode(JSON.stringify(event));

    await queue.publish(subject, payload, "msg-1");
    await queue.publish(subject, payload, "msg-2");
    await waitFor(() => results.length >= 2);

    const inserted = results.filter((result) => result.status === "inserted");
    const duplicates = results.filter(
      (result) => result.status === "duplicate",
    );

    expect(inserted).toHaveLength(1);
    expect(duplicates).toHaveLength(1);

    const stored = await store.events.findByIdempotencyKey(
      event.idempotencyKey,
    );
    expect(stored?.eventId).toBe(event.eventId);
  });
});
