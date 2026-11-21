import path from "node:path";
import { StoreEvolutionRepository } from "@kit/evolution";
import { NatsEventQueue } from "@kit/queue";
import { initStore } from "@kit/store";
import {
  type AutoDispatchLoop,
  type AutoDispatchPassSummary,
  startInformationAutoDispatch,
} from "@kit/trigger";
import { createTemporalClient } from "@kit/workflow";
import { type CollectionLoop, startCollectionLoop } from "./collector";
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

const evolutionRepo = new StoreEvolutionRepository(store, {
  workspaceId,
  variantsRoot: path.join(repoRoot, "variants"),
});
const router = new EventRouter(
  store,
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

// Automatic information → reaction dispatch (98 §5.2 G1, D-70). Default ON:
// the main 1.0 gate forbids requiring an operator to start reactions. Set
// KIT_REACTION_AUTO_DISPATCH=0 to turn only this edge off; manual replay
// (`kit reaction run`) keeps working and cannot double-fire thanks to the
// TriggerRun dedupe key.
const dispatcher = startReactionAutoDispatch();
if (!dispatcher) {
  console.log(
    "[runtime] reaction auto-dispatch disabled (KIT_REACTION_AUTO_DISPATCH=0)",
  );
}

// Continuous passive collection (98 I-1) is opt-in: enabling it means the
// runtime actually pulls external sources on an interval, so it never starts
// unless KIT_INFORMATION_COLLECT names the sources to watch.
const collector = startInformationCollector();
if (!collector) {
  console.log(
    "[runtime] information collection disabled (set KIT_INFORMATION_COLLECT)",
  );
}

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log("[runtime] shutting down");
  dispatcher?.stop();
  collector?.stop();
  await stop();
  await queue.close();
  await store.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function startInformationCollector(): CollectionLoop | null {
  const configured = process.env.KIT_INFORMATION_COLLECT?.trim();
  if (!configured || configured === "0") {
    return null;
  }
  const sources = configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const intervalMs = Number(process.env.KIT_INFORMATION_INTERVAL_MS ?? "");
  const loop = startCollectionLoop(store, {
    workspaceId,
    sources: sources.length > 0 ? sources : undefined,
    intervalMs:
      Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : undefined,
    onRun: (summary) => {
      console.log(
        `[runtime] information ${summary.eventsCreated} new / ${summary.duplicates} duplicate across ${summary.sources.length} sources`,
      );
      // Dispatch immediately after a pass; the timer is the safety net for
      // events written by other producers (scout, CLI, console).
      if (dispatcher && summary.eventsCreated > 0) {
        void dispatcher
          .runOnce()
          .then(reportDispatch)
          .catch((error: unknown) => {
            console.error(
              `[runtime] reaction auto-dispatch failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }
    },
    onError: (error) => {
      console.error(
        `[runtime] information collection error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  });
  return loop;
}

function startReactionAutoDispatch(): AutoDispatchLoop | null {
  const intervalMs = Number(
    process.env.KIT_REACTION_DISPATCH_INTERVAL_MS ?? "",
  );
  return startInformationAutoDispatch(store, {
    repoRoot,
    workspaceId,
    env: process.env,
    ...(Number.isFinite(intervalMs) && intervalMs > 0 ? { intervalMs } : {}),
    onPass: reportDispatch,
    onError: (error) => {
      console.error(
        `[runtime] reaction auto-dispatch error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  });
}

function reportDispatch(summary: AutoDispatchPassSummary): void {
  if (
    summary.events === 0 &&
    summary.retried === 0 &&
    summary.errors.length === 0
  ) {
    return;
  }
  console.log(
    `[runtime] information dispatch ${summary.fired} fired / ${summary.existing} existing / ${summary.skipped} skipped / ${summary.failed} failed / ${summary.deferred} retry pending (${summary.events} new, ${summary.retried} retried)`,
  );
  for (const error of summary.errors) {
    console.error(`[runtime] dispatch error: ${error}`);
  }
}

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
