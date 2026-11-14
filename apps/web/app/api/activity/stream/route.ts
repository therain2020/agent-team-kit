import { ensureStoreSchema, getStore } from "@/lib/store";
import { type ActivityEvent, listActivity } from "@kit/activity";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await ensureStoreSchema();
  const store = getStore();
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId") || undefined;
  const agentId = url.searchParams.get("agentId") || undefined;
  const kind = url.searchParams.get("kind") || undefined;
  const afterHeader = request.headers.get("last-event-id");
  const afterParam = url.searchParams.get("after");
  let lastEventId = Number(afterHeader ?? afterParam ?? 0);
  if (!Number.isFinite(lastEventId) || lastEventId < 0) {
    lastEventId = 0;
  }
  if (url.searchParams.get("live") === "1") {
    const rows = await store.sql<Array<{ max: string | number }>>`
      SELECT COALESCE(MAX(event_id), 0) AS max FROM activity_events
    `;
    lastEventId = Number(rows[0]?.max ?? 0);
  }

  const encoder = new TextEncoder();
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
      const send = (event: ActivityEvent) => {
        if (closed) {
          return;
        }
        lastEventId = Math.max(lastEventId, event.eventId);
        controller.enqueue(
          encoder.encode(
            `id: ${event.eventId}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      };

      const drain = async (): Promise<void> => {
        if (closed) {
          return;
        }
        const events = await listActivity(store, {
          ...(runId ? { runId } : {}),
          ...(agentId ? { agentId } : {}),
          ...(kind ? { kind } : {}),
          after: lastEventId,
          limit: 500,
        });
        for (const event of events) {
          send(event);
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
              if (!runId || payload.runId === runId) {
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
          }, 1000);
        }
        heartbeat = setInterval(() => {
          if (!closed) {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              void close(controller);
            }
          }
        }, 15_000);
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
