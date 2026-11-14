import { jobErrorResponse } from "@/lib/job-api";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { type JobKind, getJob } from "@kit/job";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId: raw } = await params;
  const jobId = decodeURIComponent(raw);
  const url = new URL(request.url);
  const kind = parseKind(url.searchParams.get("kind"));

  try {
    await ensureStoreSchema();
    const store = getStore();
    const candidates: JobKind[] = kind ? [kind] : ["iteration", "packRun"];
    for (const candidate of candidates) {
      const job = await getJob(store, candidate, jobId);
      if (job) {
        return NextResponse.json({ job });
      }
    }
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  } catch (error) {
    return jobErrorResponse(error);
  }
}

function parseKind(value: string | null): JobKind | undefined {
  return value === "iteration" || value === "packRun" ? value : undefined;
}
