import { type OfficeSnapshotPayload, loadOfficeData } from "@/lib/office";
import { resolvePackDir } from "@/lib/paths";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { NextResponse } from "next/server";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/office?pack=<dir>` → lightweight office snapshot (97 §3.2).
 *
 * Used by the floor when the world stream reveals a run this Pack owns but the
 * server-rendered mission list predates it: the debounced refetch adds the
 * mission card without a full page reload. The payload carries the activity
 * cursor (`MAX(event_id)`) so a caller can resume the stream from it.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const pack = url.searchParams.get("pack");
  if (!pack) {
    return NextResponse.json({ error: "pack is required" }, { status: 400 });
  }
  const dir = resolvePackDir(pack);
  if (!dir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }
  const dirName = path.basename(dir);

  await ensureStoreSchema();
  try {
    const data = await loadOfficeData(dirName);
    if (!data.active || data.active.dirName !== dirName) {
      return NextResponse.json(
        { error: "pack not found or invalid" },
        { status: 404 },
      );
    }
    const rows = await getStore().sql<Array<{ max: string | number }>>`
      SELECT COALESCE(MAX(event_id), 0) AS max FROM activity_events
    `;
    const payload: OfficeSnapshotPayload = {
      active: data.active,
      cursor: Number(rows[0]?.max ?? 0),
      generatedAt: new Date().toISOString(),
    };
    return NextResponse.json(payload, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "failed to load office",
      },
      { status: 500 },
    );
  }
}
