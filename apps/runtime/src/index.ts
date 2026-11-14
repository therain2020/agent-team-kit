import { NatsEventQueue } from "@kit/queue";
import { initStore } from "@kit/store";
import { EventIngestor } from "./ingestor";

const natsUrl = process.env.KIT_NATS_URL ?? "nats://localhost:4222";
const stream = process.env.KIT_NATS_STREAM ?? "KIT_EVENTS";
const subject = process.env.KIT_NATS_SUBJECT ?? "kit.events.>";

const store = await initStore();
const queue = new NatsEventQueue({
  url: natsUrl,
  stream,
  subjects: [subject],
});

await queue.connect();

const ingestor = new EventIngestor(store.events);
const stop = await queue.subscribe(subject, async (message) => {
  try {
    const result = await ingestor.handle(message.data);
    console.log(
      `[runtime] ${result.status} ${result.eventType} ${result.eventId}`,
    );
  } catch (error) {
    // D3 drops poison messages; D4 adds a DLQ path.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[runtime] dropped invalid event: ${reason}`);
  }
});

console.log(
  `[runtime] consuming ${natsUrl} stream=${stream} subject=${subject}`,
);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log("[runtime] shutting down");
  await stop();
  await queue.close();
  await store.sql.end();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
