import { loadIncidentOverview } from "@/lib/incident";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Read-only incident + runbook coverage surface (61 §3.4, §5). */
export async function GET(request: Request) {
  try {
    const workspaceId =
      new URL(request.url).searchParams.get("workspaceId") ?? undefined;
    const overview = await loadIncidentOverview(workspaceId);
    return NextResponse.json(overview);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "failed to load incidents";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
