import { decideApproval } from "@/lib/decisions";
import { sameOriginError } from "@/lib/http";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  const { id } = await params;
  const runId = decodeURIComponent(id);

  let body: {
    decision?: unknown;
    note?: unknown;
    requestId?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const decision = body.decision;
  if (decision !== "approve" && decision !== "abort") {
    return NextResponse.json(
      { error: "decision must be approve or abort" },
      { status: 400 },
    );
  }
  const note = typeof body.note === "string" ? body.note.slice(0, 2000) : "";
  if (decision === "abort" && note.trim().length === 0) {
    return NextResponse.json(
      { error: "a note is required to abort" },
      { status: 400 },
    );
  }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!requestId) {
    return NextResponse.json(
      { error: "requestId is required" },
      { status: 400 },
    );
  }

  const outcome = await decideApproval({
    runId,
    requestId,
    decision,
    note,
    actor: "operator:web",
  });

  if (!outcome.ok) {
    return NextResponse.json(
      {
        error: outcome.error,
        ...(outcome.currentRequestId
          ? { currentRequestId: outcome.currentRequestId }
          : {}),
        ...(outcome.recorded !== undefined
          ? { recorded: outcome.recorded, signaled: outcome.signaled }
          : {}),
      },
      { status: outcome.status },
    );
  }

  return NextResponse.json({
    ok: true,
    recorded: true,
    signaled: true,
    duplicate: outcome.duplicate,
    requestId: outcome.requestId,
    decision: outcome.decision,
  });
}
