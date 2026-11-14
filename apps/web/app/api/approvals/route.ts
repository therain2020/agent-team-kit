import { authorizeApprovalApi } from "@/lib/approval-auth";
import { loadPendingApprovals } from "@/lib/approvals";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = authorizeApprovalApi(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const approvals = await loadPendingApprovals();
  return NextResponse.json({
    approvals,
    tokenConfigured: true,
  });
}
