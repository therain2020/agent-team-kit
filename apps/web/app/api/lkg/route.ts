import { loadLkgOverview } from "@/lib/lkg";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const workspaceId =
      new URL(request.url).searchParams.get("workspaceId") ?? undefined;
    const entries = await loadLkgOverview(workspaceId);
    return NextResponse.json({ entries });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "failed to load last-known-good";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
