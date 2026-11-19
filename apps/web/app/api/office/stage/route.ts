import { sameOriginError } from "@/lib/http";
import { loadStageDetail } from "@/lib/stage-detail-server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/office/stage?pack=<dir>&runId=<id>&stageId=<id>` → stage drawer
 * payload (issue #156). The office floor calls this on click; the drawer opens
 * immediately and fills in when this resolves.
 */
export async function GET(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  const url = new URL(request.url);
  const pack = url.searchParams.get("pack");
  const runId = url.searchParams.get("runId");
  const stageId = url.searchParams.get("stageId");

  if (!pack || !runId) {
    return NextResponse.json(
      { error: "pack and runId are required" },
      { status: 400 },
    );
  }

  try {
    const detail = await loadStageDetail(pack, runId, stageId);
    return NextResponse.json(detail, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "failed to load stage",
      },
      { status: 500 },
    );
  }
}
