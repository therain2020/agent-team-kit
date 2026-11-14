import { decideApproval } from "@/lib/decisions";
import { MAX_BATCH_SIZE, validateBatchInput } from "@/lib/factory";
import { sameOriginError } from "@/lib/http";
import { getStore } from "@/lib/store";
import { newId } from "@kit/core";
import { findApprovalRequest } from "@kit/manager";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type BatchResult = {
  runId: string;
  requestId: string;
  ok: boolean;
  status: number;
  error?: string;
  batchId?: string;
};

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const validation = validateBatchInput(body);
  if (!validation.ok) {
    const message =
      validation.error === "too-large"
        ? `batch limited to ${MAX_BATCH_SIZE} items`
        : validation.error === "empty"
          ? "items must be a non-empty array"
          : "items must include runId and requestId";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const store = await getStore();
  const batchId = newId("batch");
  const results: BatchResult[] = [];

  for (const target of validation.targets) {
    const approval = await findApprovalRequest(store, target.runId);
    if (!approval) {
      results.push({
        ...target,
        ok: false,
        status: 404,
        error: "approval request not found",
      });
      continue;
    }
    if (approval.requestId !== target.requestId) {
      results.push({
        ...target,
        ok: false,
        status: 409,
        error: "stale approval request",
      });
      continue;
    }
    if (approval.riskClass !== "low") {
      results.push({
        ...target,
        ok: false,
        status: 403,
        error: "batch approvals are limited to low risk",
      });
      continue;
    }

    const outcome = await decideApproval({
      runId: target.runId,
      requestId: target.requestId,
      decision: "approve",
      note: "",
      actor: "operator:web:batch",
      batchId,
    });
    results.push(
      outcome.ok
        ? {
            ...target,
            ok: true,
            status: 200,
            batchId: outcome.batchId,
          }
        : {
            ...target,
            ok: false,
            status: outcome.status,
            error: outcome.error,
          },
    );
  }

  const approved = results.filter((result) => result.ok).length;
  return NextResponse.json({
    batchId,
    requested: validation.targets.length,
    approved,
    failed: results.length - approved,
    results,
  });
}
