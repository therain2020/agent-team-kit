import { sameOriginError } from "@/lib/http";
import { jobErrorResponse } from "@/lib/job-api";
import { getRepoRoot } from "@/lib/paths";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { JobError, applyPendingChange, listPendingChanges } from "@kit/job";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string; ticketId: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  const { jobId: rawJobId, ticketId: rawTicketId } = await params;
  const jobId = decodeURIComponent(rawJobId);
  const ticketId = decodeURIComponent(rawTicketId);

  let body: { note?: unknown; actor?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) {
    return NextResponse.json(
      { error: "a note is required to apply a pending change" },
      { status: 400 },
    );
  }

  try {
    await ensureStoreSchema();
    const store = getStore();
    const changes = await listPendingChanges(store, jobId);
    if (!changes.some((change) => change.ticketId === ticketId)) {
      throw new JobError(
        "not_found",
        "pending change not found for this job",
        404,
      );
    }
    const result = await applyPendingChange(store, ticketId, {
      actor: typeof body.actor === "string" ? body.actor : "operator:web",
      note,
      repoRoot: getRepoRoot(),
    });
    return NextResponse.json(result);
  } catch (error) {
    return jobErrorResponse(error);
  }
}
