import path from "node:path";
import { StoreEvolutionRepository } from "@kit/evolution";
import { NatsEventQueue } from "@kit/queue";
import { initStore } from "@kit/store";
import { createTemporalClient } from "@kit/workflow";
import { EventIngestor } from "./ingestor";
import { EventRouter, EvolutionRunVariantSelector } from "./router";

const natsUrl = process.env.KIT_NATS_URL ?? "nats://localhost:4222";
const stream = process.env.KIT_NATS_STREAM ?? "KIT_EVENTS";
const subject = process.env.KIT_NATS_SUBJECT ?? "kit.events.>";

const repoRoot = resolveRepoRoot();
const workspaceId = process.env.KIT_WORKSPACE_ID ?? "default";

const store = await initStore();
const queue = new NatsEventQueue({
  url: natsUrl,
  stream,
  subjects: [subject],
});

await queue.connect();

const temporal = await createTemporalClient();
const evolutionRepo = new StoreEvolutionRepository(store, {
  workspaceId,
  variantsRoot: path.join(repoRoot, "variants"),
});
const router = new EventRouter(
  store,
  temporal,
  repoRoot,
  new EvolutionRunVariantSelector(evolutionRepo),
  workspaceId,
);
const ingestor = new EventIngestor(store.events);

const stop = await queue.subscribe(subject, async (message) => {
  try {
    const result = await ingestor.handle(message.data);
    console.log(
      `[runtime] ${result.status} ${result.eventType} ${result.eventId}`,
    );
    if (result.status !== "inserted") {
      return;
    }
    const routed = await router.route(result.event, result.payload);
    if (routed.started.length > 0) {
      console.log(
        `[runtime] routed ${result.eventType}: ${routed.started
          .map(
            (item) =>
              `${item.pack}/${item.workflow}${item.variant ? ` (${item.variant})` : ""}`,
          )
          .join(", ")}`,
      );
    }
    for (const skipped of routed.skipped) {
      console.log(
        `[runtime] skipped ${skipped.pack}/${skipped.workflow}: ${skipped.reason}`,
      );
    }
    for (const error of routed.errors) {
      console.error(`[runtime] route error: ${error}`);
    }
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
  await temporal.connection.close();
  await store.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function resolveRepoRoot(): string {
  const cwd = process.cwd();
  if (
    path.basename(cwd) === "runtime" &&
    path.basename(path.dirname(cwd)) === "apps"
  ) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}
