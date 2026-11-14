import { authorizeApprovalApi } from "@/lib/approval-auth";
import { findRunIdForRequest } from "@/lib/approvals";
import { decideApproval } from "@/lib/decisions";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const auth = authorizeApprovalApi(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { requestId: rawRequestId } = await params;
  const requestId = decodeURIComponent(rawRequestId);
  let body: { decision?: unknown; note?: unknown };
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

  const runId = await findRunIdForRequest(requestId);
  if (!runId) {
    return NextResponse.json(
      { error: "approval request not found" },
      { status: 404 },
    );
  }

  const outcome = await decideApproval({
    runId,
    requestId,
    decision,
    note,
    actor: "operator:api",
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
    requestId,
    runId,
    decision,
    duplicate: outcome.duplicate,
  });
}
