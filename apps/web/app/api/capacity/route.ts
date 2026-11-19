import { loadCapacityOverview } from "@/lib/capacity";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const workspaceId =
      new URL(request.url).searchParams.get("workspaceId")?.trim() || "default";
    return NextResponse.json(await loadCapacityOverview(workspaceId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "load failed" },
      { status: 500 },
    );
  }
}
