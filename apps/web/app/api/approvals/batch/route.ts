import { decideApproval } from "@/lib/decisions";
import { MAX_BATCH_SIZE, validateBatchInput } from "@/lib/factory";
import { sameOriginError } from "@/lib/http";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { newId } from "@kit/core";
import { findApprovalRequest } from "@kit/manager";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type BatchDecision = "approve" | "reject";

type BatchTarget = {
  runId: string;
  requestId: string;
  version: number | null;
};

type BatchResult = {
  runId: string;
  requestId: string;
  version: number | null;
  decision: BatchDecision;
  ok: boolean;
  status: number;
  error?: string;
  batchId?: string;
};

function parseDecision(value: unknown): BatchDecision | null {
  if (value === undefined || value === "approve") {
    return "approve";
  }
  return value === "reject" ? "reject" : null;
}

function parseVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

/**
 * Batch approve/reject. Every item carries its own outcome: a stale version,
 * race or policy refusal fails that item only and is surfaced to the operator.
 * Approvals stay limited to the low risk class; rejections are always allowed.
 */
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

  const rawBody = body as {
    decision?: unknown;
    note?: unknown;
    items?: Array<{ version?: unknown }>;
  };
  const decision = parseDecision(rawBody.decision);
  if (!decision) {
    return NextResponse.json(
      { error: "decision must be approve or reject" },
      { status: 400 },
    );
  }
  const note =
    typeof rawBody.note === "string" ? rawBody.note.slice(0, 2000) : "";
  if (decision === "reject" && note.trim().length === 0) {
    return NextResponse.json(
      { error: "a note is required to reject" },
      { status: 400 },
    );
  }

  const versions = new Map<string, number | null>();
  for (const item of Array.isArray(rawBody.items) ? rawBody.items : []) {
    const value = item as { runId?: unknown; requestId?: unknown };
    if (
      typeof value.runId === "string" &&
      typeof value.requestId === "string"
    ) {
      versions.set(
        `${value.runId}::${value.requestId}`,
        parseVersion((item as { version?: unknown }).version),
      );
    }
  }
  const targets: BatchTarget[] = validation.targets.map((target) => ({
    ...target,
    version: versions.get(`${target.runId}::${target.requestId}`) ?? null,
  }));

  await ensureStoreSchema();
  const store = await getStore();
  const batchId = newId("batch");
  const results: BatchResult[] = [];

  for (const target of targets) {
    const approval = await findApprovalRequest(store, target.runId);
    if (!approval) {
      results.push({
        ...target,
        decision,
        ok: false,
        status: 404,
        error: "approval request not found",
      });
      continue;
    }
    if (approval.requestId !== target.requestId) {
      results.push({
        ...target,
        decision,
        ok: false,
        status: 409,
        error: "stale approval request",
      });
      continue;
    }

    const record = await store.approvals.get(target.requestId);
    if (record) {
      if (record.runId !== target.runId) {
        results.push({
          ...target,
          decision,
          ok: false,
          status: 409,
          error: "stale approval request",
        });
        continue;
      }
      if (record.status !== "queued") {
        results.push({
          ...target,
          decision,
          ok: false,
          status: 409,
          error: `approval is ${record.status}`,
        });
        continue;
      }
      if (target.version !== null && record.version !== target.version) {
        results.push({
          ...target,
          decision,
          ok: false,
          status: 409,
          error: "approval version conflict",
        });
        continue;
      }
    }

    if (decision === "approve" && approval.riskClass !== "low") {
      results.push({
        ...target,
        decision,
        ok: false,
        status: 403,
        error: "batch approvals are limited to low risk",
      });
      continue;
    }

    const outcome = await decideApproval({
      runId: target.runId,
      requestId: target.requestId,
      decision: decision === "approve" ? "approve" : "abort",
      note,
      actor: "operator:web:batch",
      batchId,
    });
    results.push(
      outcome.ok
        ? {
            ...target,
            decision,
            ok: true,
            status: 200,
            batchId: outcome.batchId,
          }
        : {
            ...target,
            decision,
            ok: false,
            status: outcome.status,
            error: outcome.error,
          },
    );
  }

  const succeeded = results.filter((result) => result.ok).length;
  return NextResponse.json({
    batchId,
    decision,
    requested: targets.length,
    succeeded,
    approved: decision === "approve" ? succeeded : 0,
    rejected: decision === "reject" ? succeeded : 0,
    failed: results.length - succeeded,
    results,
  });
}
