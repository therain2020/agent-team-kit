import { loadFactoryDetail } from "@/lib/factory-server";
import { sameOriginError } from "@/lib/http";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  const { runId: rawRunId } = await params;
  const runId = decodeURIComponent(rawRunId);
  const detail = await loadFactoryDetail(runId);
  if (!detail) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  return NextResponse.json(detail);
}
