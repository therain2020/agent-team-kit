import { type ActivityEvent, listActivity } from "@kit/activity";
import { CliError } from "@kit/core";
import { initStore } from "@kit/store";
import type { Command } from "commander";
import { emitError, printJsonLine, wantsJson } from "../output";

export interface ActivityBatch {
  events: ActivityEvent[];
  /** Cursor to resume from: the last delivered event id, or the input cursor. */
  cursor: number;
}

export interface ActivityBatchOptions {
  after?: number;
  limit?: number;
  runId?: string;
  agentId?: string;
  kind?: string;
}

type Store = Awaited<ReturnType<typeof initStore>>;

/**
 * Read one ordered batch from the activity stream. `activity_events.event_id`
 * is monotonic, so `after = last.eventId` is a resumable cursor and repeated
 * polling can never skip or duplicate an event (at-most-once per cursor).
 */
export async function readActivityBatch(
  store: Store,
  options: ActivityBatchOptions = {},
): Promise<ActivityBatch> {
  const after = normalizeCursor(options.after);
  const events = await listActivity(store, {
    after,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.kind ? { kind: options.kind } : {}),
  });
  const last = events[events.length - 1];
  return { events, cursor: last ? last.eventId : after };
}

export interface TailActivityOptions extends ActivityBatchOptions {
  once?: boolean;
  intervalMs?: number;
  shouldStop?: () => boolean;
  onBatch: (batch: ActivityBatch) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Tail the activity stream. With `once` we read a single batch (used by tests
 * and one-shot agents); otherwise we poll forever until `shouldStop` flips.
 * Never reads stdin, so it is safe in non-interactive environments.
 */
export async function tailActivity(
  store: Store,
  options: TailActivityOptions,
): Promise<number> {
  const intervalMs = Math.max(50, options.intervalMs ?? 1000);
  const sleep = options.sleep ?? delay;
  let cursor = normalizeCursor(options.after);

  for (;;) {
    const batch = await readActivityBatch(store, {
      ...options,
      after: cursor,
    });
    if (batch.events.length > 0) {
      await options.onBatch(batch);
      cursor = batch.cursor;
    }
    if (options.once === true) {
      return cursor;
    }
    if (options.shouldStop?.()) {
      return cursor;
    }
    await sleep(intervalMs);
  }
}

interface WatchOptions {
  after?: string;
  limit?: string;
  once?: boolean;
  interval?: string;
  run?: string;
  agent?: string;
  kind?: string;
  json?: boolean;
}

export function registerWatch(program: Command): void {
  program
    .command("watch")
    .description(
      "Tail activity events from a resumable cursor (--after <seq>, NDJSON with --json)",
    )
    .option("--after <seq>", "resume after this event id", "0")
    .option("--limit <n>", "events per batch (1-500)", "100")
    .option("--once", "read one batch and exit (non-blocking)", false)
    .option("--interval <ms>", "poll interval between batches", "1000")
    .option("--run <runId>", "only events for this run")
    .option("--agent <agentId>", "only events for this agent")
    .option("--kind <kind>", "only events of this kind")
    .option("--json", "print NDJSON envelopes", false)
    .action(async (options: WatchOptions) => {
      const json = wantsJson(options);
      const after = parseInteger(options.after, 0, "--after");
      const limit = parseInteger(options.limit, 100, "--limit");
      const intervalMs = parseInteger(options.interval, 1000, "--interval");

      let store: Store;
      try {
        store = await initStore();
      } catch (error) {
        emitError(
          json,
          new CliError(
            "dependency_unavailable",
            "cannot reach the kit database",
            {
              hint: "start the stack with `kit up`, point KIT_LOCAL_DB/KIT_DB_URL at a database, or check KIT_RUNTIME_MODE",
              cause: error,
            },
          ),
        );
        return;
      }

      let stopped = false;
      const stop = () => {
        stopped = true;
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);

      try {
        await tailActivity(store, {
          after,
          limit,
          once: options.once === true,
          intervalMs,
          ...(options.run ? { runId: options.run } : {}),
          ...(options.agent ? { agentId: options.agent } : {}),
          ...(options.kind ? { kind: options.kind } : {}),
          shouldStop: () => stopped,
          onBatch: (batch) => {
            for (const event of batch.events) {
              if (json) {
                printJsonLine(event);
              } else {
                console.log(formatEvent(event));
              }
            }
          },
        });
      } catch (error) {
        emitError(json, error);
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        await store.close();
      }
    });
}

function formatEvent(event: ActivityEvent): string {
  const subject = event.summary ?? event.kind;
  return `${event.eventId}  ${event.kind}  ${subject}`;
}

export function normalizeCursor(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.trunc(parsed);
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  flag: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError("usage", `${flag} must be a non-negative integer`);
  }
  return Math.trunc(parsed);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
