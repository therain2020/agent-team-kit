import { type EventRow, mapEvent } from "@/lib/iteration-mapping";
import type { IterationEventPage } from "@/lib/iteration-types";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ iterationId: string }> },
) {
  await ensureStoreSchema();
  const { iterationId } = await context.params;
  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), 1, 500, 200);
  const after = numberOrNull(url.searchParams.get("after"));
  const before = numberOrNull(url.searchParams.get("before"));
  const task = url.searchParams.get("task") || null;
  const kind = url.searchParams.get("kind") || null;
  const kindPrefix = kind ? `${kind}.%` : null;
  const store = getStore();

  const rows =
    before !== null
      ? await store.sql<EventRow[]>`
        SELECT * FROM iteration_events
        WHERE iteration_id = ${iterationId}
          AND (${before}::bigint IS NULL OR event_id < ${before})
          AND (${task}::text IS NULL OR task_id = ${task})
          AND (
            ${kind}::text IS NULL
            OR kind = ${kind}
            OR kind LIKE ${kindPrefix}
          )
        ORDER BY event_id DESC
        LIMIT ${limit + 1}
      `
      : await store.sql<EventRow[]>`
        SELECT * FROM iteration_events
        WHERE iteration_id = ${iterationId}
          AND (${after}::bigint IS NULL OR event_id > ${after})
          AND (${task}::text IS NULL OR task_id = ${task})
          AND (
            ${kind}::text IS NULL
            OR kind = ${kind}
            OR kind LIKE ${kindPrefix}
          )
        ORDER BY event_id ASC
        LIMIT ${limit + 1}
      `;

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const events = (before !== null ? page.reverse() : page).map(mapEvent);
  const data: IterationEventPage = { events, hasMore };
  return NextResponse.json(data);
}

function numberOrNull(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function clampInt(
  value: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === null || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
