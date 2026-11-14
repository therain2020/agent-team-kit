import { sameOriginError } from "@/lib/http";
import { resetManagerBudget } from "@/lib/manager-budget";
import { getStore } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: { runId?: unknown };
  try {
    body = (await request.json()) as { runId?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.runId !== "string" || body.runId.length === 0) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }

  const store = getStore();
  const run = await store.runs.get(body.runId);
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  await resetManagerBudget({
    workspaceId: run.workspaceId,
    sessionId: run.runId,
    store,
  });
  return NextResponse.json({ ok: true });
}
