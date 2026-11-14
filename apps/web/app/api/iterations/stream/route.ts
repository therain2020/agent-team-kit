import { type EventRow, mapEvent } from "@/lib/iteration-mapping";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await ensureStoreSchema();
  const store = getStore();
  const url = new URL(request.url);
  const iterationId = url.searchParams.get("iterationId") ?? "*";
  const afterHeader = request.headers.get("last-event-id");
  const afterParam = url.searchParams.get("after");
  let lastEventId = Number(afterHeader ?? afterParam ?? 0);
  if (!Number.isFinite(lastEventId) || lastEventId < 0) {
    lastEventId = 0;
  }
  if (url.searchParams.get("live") === "1") {
    const rows = await store.sql<Array<{ max: string }>>`
      SELECT COALESCE(MAX(event_id), 0)::text AS max FROM iteration_events
    `;
    lastEventId = Number(rows[0]?.max ?? 0);
  }

  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let listen: { unlisten(): Promise<void> } | undefined;

  const close = async (controller?: ReadableStreamDefaultController) => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
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
      const send = (event: ReturnType<typeof mapEvent>) => {
        if (closed) {
          return;
        }
        lastEventId = Math.max(lastEventId, event.eventId);
        controller.enqueue(
          encoder.encode(
            `id: ${event.eventId}\nevent: iteration\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      };

      const drain = async (): Promise<void> => {
        if (closed) {
          return;
        }
        const rows =
          iterationId === "*"
            ? await store.sql<EventRow[]>`
                SELECT * FROM iteration_events
                WHERE event_id > ${lastEventId}
                ORDER BY event_id ASC
                LIMIT 500
              `
            : await store.sql<EventRow[]>`
                SELECT * FROM iteration_events
                WHERE iteration_id = ${iterationId}
                  AND event_id > ${lastEventId}
                ORDER BY event_id ASC
                LIMIT 500
              `;
        for (const row of rows) {
          send(mapEvent(row));
        }
        if (rows.length === 500) {
          await drain();
        }
      };

      try {
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        await drain();
        listen = await store.sql.listen("kit_iteration_events", (value) => {
          try {
            const payload = JSON.parse(value) as { iterationId?: string };
            if (iterationId === "*" || payload.iterationId === iterationId) {
              void drain().catch(() => {
                void close(controller);
              });
            }
          } catch {
            // ignore malformed notifications
          }
        });
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
