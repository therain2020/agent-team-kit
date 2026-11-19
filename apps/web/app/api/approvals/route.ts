import { authorizeApprovalApi } from "@/lib/approval-auth";
import { ensureApprovalsBackfill, loadPendingApprovals } from "@/lib/approvals";
import { APPROVAL_STATUSES, type ApprovalStatus } from "@kit/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_LIMIT = 200;

export async function GET(request: Request) {
  const auth = authorizeApprovalApi(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const params = new URL(request.url).searchParams;

  const statusParam = params.get("status");
  let status: ApprovalStatus | undefined;
  if (statusParam !== null) {
    if (!APPROVAL_STATUSES.includes(statusParam as ApprovalStatus)) {
      return NextResponse.json(
        { error: `status must be one of ${APPROVAL_STATUSES.join(", ")}` },
        { status: 400 },
      );
    }
    status = statusParam as ApprovalStatus;
  }

  const sortParam = params.get("sort");
  if (sortParam !== null && sortParam !== "due" && sortParam !== "created") {
    return NextResponse.json(
      { error: "sort must be due or created" },
      { status: 400 },
    );
  }

  const limitParam = params.get("limit");
  const limit = limitParam === null ? undefined : Number(limitParam);
  if (
    limit !== undefined &&
    (!Number.isFinite(limit) || limit < 1 || limit > MAX_LIMIT)
  ) {
    return NextResponse.json(
      { error: `limit must be between 1 and ${MAX_LIMIT}` },
      { status: 400 },
    );
  }

  await ensureApprovalsBackfill();

  const { approvals, nextCursor } = await loadPendingApprovals(undefined, {
    status,
    sort: sortParam === "created" ? "created" : "due",
    cursor: params.get("cursor"),
    ...(limit !== undefined ? { limit } : {}),
  });

  return NextResponse.json({
    approvals,
    tokenConfigured: true,
    ...(nextCursor ? { nextCursor } : {}),
  });
}
