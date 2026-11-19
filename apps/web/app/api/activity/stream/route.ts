import {
  createActivityStreamResponse,
  resolveActivityCursor,
} from "@/lib/activity-stream";
import { ensureStoreSchema, getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await ensureStoreSchema();
  const store = getStore();
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId") || undefined;
  const agentId = url.searchParams.get("agentId") || undefined;
  const kind = url.searchParams.get("kind") || undefined;

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
    filters: {
      ...(runId ? { runId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(kind ? { kind } : {}),
    },
  });
}
