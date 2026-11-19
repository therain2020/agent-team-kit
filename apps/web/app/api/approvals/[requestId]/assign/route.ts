import { sameOriginError } from "@/lib/http";
import { currentOperatorId } from "@/lib/operator";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { appendActivity } from "@kit/activity";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Takeover: assign a queued approval to the current operator (CAS on version). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  const { requestId: rawRequestId } = await params;
  const requestId = decodeURIComponent(rawRequestId);

  let body: { assignee?: unknown; version?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const operator = currentOperatorId();
  const assignee =
    typeof body.assignee === "string" && body.assignee.trim().length > 0
      ? body.assignee.trim().slice(0, 120)
      : operator;
  const expectedVersion =
    typeof body.version === "number" && Number.isFinite(body.version)
      ? Math.trunc(body.version)
      : null;

  await ensureStoreSchema();
  const store = await getStore();
  const record = await store.approvals.get(requestId);
  if (!record) {
    return NextResponse.json(
      { error: "approval request not found" },
      { status: 404 },
    );
  }

  const outcome = await store.approvals.assign({
    approvalId: requestId,
    expectedVersion: expectedVersion ?? record.version,
    assignee,
  });

  if (!outcome.ok) {
    return NextResponse.json(
      {
        error:
          outcome.code === "version_conflict"
            ? "approval version conflict"
            : outcome.code === "not_pending"
              ? `approval is ${outcome.current?.status ?? "not pending"}`
              : "approval request not found",
        ...(outcome.current
          ? {
              currentVersion: outcome.current.version,
              currentAssignee: outcome.current.assignee,
              currentStatus: outcome.current.status,
            }
          : {}),
      },
      {
        status:
          outcome.code === "version_conflict"
            ? 409
            : outcome.code === "not_pending"
              ? 409
              : 404,
      },
    );
  }

  await appendActivity(store, {
    runId: outcome.record.runId,
    stageId: outcome.record.stageId ?? undefined,
    agentId: "operator",
    kind: "approval.assigned",
    status: "assigned",
    summary: `approval ${requestId} taken over by ${assignee}`,
    payload: {
      requestId,
      assignee,
      actor: operator,
      version: outcome.record.version,
    },
  }).catch(() => undefined);

  return NextResponse.json({
    ok: true,
    requestId,
    assignee: outcome.record.assignee,
    assignedAt: outcome.record.assignedAt,
    version: outcome.record.version,
  });
}
