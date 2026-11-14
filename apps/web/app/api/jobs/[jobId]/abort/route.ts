import { sameOriginError } from "@/lib/http";
import { jobErrorResponse } from "@/lib/job-api";
import { getRepoRoot } from "@/lib/paths";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { type JobKind, abortJob } from "@kit/job";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  const { jobId: raw } = await params;
  const jobId = decodeURIComponent(raw);
  const url = new URL(request.url);
  let kind = parseKind(url.searchParams.get("kind"));
  if (!kind) {
    try {
      const body = (await request.json()) as { kind?: unknown };
      kind = parseKind(typeof body.kind === "string" ? body.kind : null);
    } catch {
      // no body; default below
    }
  }
  if (!kind) {
    return NextResponse.json(
      { error: "kind is required (iteration or packRun)" },
      { status: 400 },
    );
  }

  try {
    await ensureStoreSchema();
    const result = await abortJob(getStore(), kind, jobId, {
      repoRoot: getRepoRoot(),
    });
    return NextResponse.json(result);
  } catch (error) {
    return jobErrorResponse(error);
  }
}

function parseKind(value: string | null): JobKind | undefined {
  return value === "iteration" || value === "packRun" ? value : undefined;
}
