import { ensureStoreSchema, getStore } from "@/lib/store";
import { ensureWorldProjectionBackfill, loadWorldSnapshot } from "@/lib/world";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/world?since=<seq>` → `{ snapshot, seq, etag }`.
 *
 * Without `since` the response is the full world snapshot (one row per run,
 * derived agent states). With `since` only runs materialized after that
 * activity cursor are returned, for cheap polling from a known seq.
 */
export async function GET(request: Request) {
  await ensureStoreSchema();
  await ensureWorldProjectionBackfill();

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId") || "default";
  const since = positiveInt(url.searchParams.get("since"));
  const limit = positiveInt(url.searchParams.get("limit"));

  try {
    const result = await loadWorldSnapshot(getStore(), {
      workspaceId,
      ...(since !== undefined ? { since } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return NextResponse.json(result, {
      headers: { etag: result.etag, "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "failed to load world",
      },
      { status: 500 },
    );
  }
}

function positiveInt(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.trunc(parsed)
    : undefined;
}
