import { sameOriginError } from "@/lib/http";
import { loadApprovalTower } from "@/lib/inbox";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Console read model for the approval tower; polled while the tab is visible. */
export async function GET(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  const snapshot = await loadApprovalTower();
  return NextResponse.json(snapshot, {
    headers: { "cache-control": "no-store" },
  });
}
