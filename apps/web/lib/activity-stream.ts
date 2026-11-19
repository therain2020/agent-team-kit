import { type ActivityEvent, listActivity } from "@kit/activity";
import { NextResponse } from "next/server";
import type { getStore } from "./store";

type Store = ReturnType<typeof getStore>;

export interface ActivityStreamFilters {
  workspaceId?: string;
  runId?: string;
  agentId?: string;
  kind?: string;
}

export interface ActivityStreamOptions {
  request: Request;
  store: Store;
  /** Exclusive cursor: only events with a greater event id are streamed. */
  after: number;
  filters?: ActivityStreamFilters;
  /** SSE event name for the default per-event frames. */
  eventName?: string;
  /** Renders a drained batch into SSE frames (replaces the default frames). */
  render?: (
    events: ActivityEvent[],
    cursor: number,
  ) => string | Promise<string>;
  /** Postgres NOTIFY filter; defaults to the runId filter. */
  accepts?: (payload: { runId?: string | null }) => boolean;
  pollMs?: number;
  heartbeatMs?: number;
}

/**
 * Reads the reconnect cursor from `Last-Event-ID` (SSE resume) or `?after=`.
 * Mirrors the `api/activity/stream` contract so both streams resume the same.
 */
export function resolveActivityCursor(request: Request, url: URL): number {
  const afterHeader = request.headers.get("last-event-id");
  const afterParam = url.searchParams.get("after");
  const parsed = Number(afterHeader ?? afterParam ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

/**
 * Shared SSE skeleton for activity and world streams: cursor drain over
 * `activity_events`, Postgres LISTEN/NOTIFY with a SQLite poll fallback,
 * heartbeats and abort/cleanup handling. The world stream reuses it with a
 * custom `render` that emits one projection delta per batch.
 */
export function createActivityStreamResponse(
  options: ActivityStreamOptions,
): NextResponse {
  const { request, store } = options;
  const eventName = options.eventName ?? "activity";
  const filters = options.filters ?? {};
  const pollMs = options.pollMs ?? 1000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const accepts =
    options.accepts ??
    ((payload: { runId?: string | null }) =>
      !filters.runId || payload.runId === filters.runId);

  const encoder = new TextEncoder();
  let cursor = options.after;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let listen: { unlisten(): Promise<void> } | undefined;

  const close = async (controller?: ReadableStreamDefaultController) => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (poll) {
      clearInterval(poll);
    }
    try {
      await listen?.unlisten();
    } catch {
      // listener may already be gone
    }
    try {
      controller?.close();
    } catch {
      // stream may already be closed
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      const drain = async (): Promise<void> => {
        if (closed) {
          return;
        }
        const events = await listActivity(store, {
          ...filters,
          after: cursor,
          limit: 500,
        });
        if (events.length === 0) {
          return;
        }
        cursor = Math.max(cursor, ...events.map((event) => event.eventId));
        const frame = options.render
          ? await options.render(events, cursor)
          : defaultFrames(events, eventName);
        if (frame && !closed) {
          controller.enqueue(encoder.encode(frame));
        }
        if (events.length === 500) {
          await drain();
        }
      };

      try {
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        await drain();
        if (store.driver === "postgres") {
          listen = await store.sql.listen("kit_activity_events", (value) => {
            try {
              const payload = JSON.parse(value) as { runId?: string | null };
              if (accepts(payload)) {
                void drain().catch(() => {
                  void close(controller);
                });
              }
            } catch {
              // ignore malformed notifications
            }
          });
        } else {
          poll = setInterval(() => {
            void drain().catch(() => {
              void close(controller);
            });
          }, pollMs);
        }
        heartbeat = setInterval(() => {
          if (!closed) {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              void close(controller);
            }
          }
        }, heartbeatMs);
        request.signal.addEventListener("abort", () => {
          void close(controller);
        });
      } catch (error) {
        try {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              })}\n\n`,
            ),
          );
        } catch {
          // ignore
        }
        await close(controller);
      }
    },
    cancel() {
      return close().catch(() => undefined);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function defaultFrames(events: ActivityEvent[], eventName: string): string {
  return events
    .map(
      (event) =>
        `id: ${event.eventId}\nevent: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
}
