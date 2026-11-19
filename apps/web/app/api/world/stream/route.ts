import {
  createActivityStreamResponse,
  resolveActivityCursor,
} from "@/lib/activity-stream";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { buildWorldDelta } from "@/lib/world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/world/stream?after=<seq>` → SSE deltas of the world projection.
 *
 * Reuses the activity stream skeleton (cursor, LISTEN/NOTIFY, heartbeat) and
 * emits one `world` frame per drained batch: `{ seq, runs, agents }` with the
 * current projection row for every run the batch touched.
 */
export async function GET(request: Request) {
  await ensureStoreSchema();
  const store = getStore();
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId") || "default";

  let after = resolveActivityCursor(request, url);
  if (url.searchParams.get("live") === "1") {
    const rows = await store.sql<Array<{ max: string | number }>>`
      SELECT COALESCE(MAX(event_id), 0) AS max FROM activity_events
    `;
    after = Number(rows[0]?.max ?? 0);
  }

  return createActivityStreamResponse({
    request,
    store,
    after,
    filters: { workspaceId },
    eventName: "world",
    render: async (events) => {
      const delta = await buildWorldDelta(store, workspaceId, events);
      return `id: ${delta.seq}\nevent: world\ndata: ${JSON.stringify(delta)}\n\n`;
    },
  });
}
