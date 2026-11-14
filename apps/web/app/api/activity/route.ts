import { ensureStoreSchema, getStore } from "@/lib/store";
import { listActivity } from "@kit/activity";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await ensureStoreSchema();
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId") || undefined;
  const agentId = url.searchParams.get("agentId") || undefined;
  const kind = url.searchParams.get("kind") || undefined;
  const before = positiveInt(url.searchParams.get("before"));
  const after = positiveInt(url.searchParams.get("after"));
  const limit = positiveInt(url.searchParams.get("limit"));

  try {
    const events = await listActivity(getStore(), {
      ...(runId ? { runId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(kind ? { kind } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return NextResponse.json({ events });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "failed to load activity",
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
