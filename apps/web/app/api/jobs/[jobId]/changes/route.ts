import { jobErrorResponse } from "@/lib/job-api";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { listPendingChanges } from "@kit/job";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId: raw } = await params;
  const jobId = decodeURIComponent(raw);
  try {
    await ensureStoreSchema();
    const changes = await listPendingChanges(getStore(), jobId);
    return NextResponse.json({ changes });
  } catch (error) {
    return jobErrorResponse(error);
  }
}
