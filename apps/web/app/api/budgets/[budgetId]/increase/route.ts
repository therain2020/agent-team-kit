import { toBudgetView } from "@/lib/budgets";
import { sameOriginError } from "@/lib/http";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { appendActivity } from "@kit/activity";
import { cnyToMicro } from "@kit/core";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ budgetId: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  const { budgetId: rawBudgetId } = await params;
  const budgetId = decodeURIComponent(rawBudgetId);
  let body: { cny?: unknown; tokens?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const cny = Number(body.cny);
  const tokens = Number(body.tokens);
  const reason =
    typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!reason) {
    return NextResponse.json(
      { error: "a reason is required to increase a budget" },
      { status: 400 },
    );
  }
  const hasCny = Number.isFinite(cny) && cny > 0;
  const hasTokens = Number.isFinite(tokens) && tokens > 0;
  if (!hasCny && !hasTokens) {
    return NextResponse.json(
      { error: "cny or tokens must be a positive number" },
      { status: 400 },
    );
  }

  await ensureStoreSchema();
  const store = getStore();
  const result = await store.budgetService.increaseLimit(budgetId, {
    ...(hasCny ? { cnyMicro: cnyToMicro(cny) } : {}),
    ...(hasTokens ? { tokens: Math.trunc(tokens) } : {}),
  });
  if (!result.ok || !result.budget) {
    const status = result.error === "budget not found" ? 404 : 409;
    return NextResponse.json(
      { error: result.error ?? "increase failed" },
      { status },
    );
  }

  try {
    await appendActivity(store, {
      workspaceId: result.budget.workspaceId,
      kind: "budget.increased",
      status: "completed",
      summary: `${result.budget.scope} ${result.budget.targetKey} increased`,
      payload: {
        budgetId,
        scope: result.budget.scope,
        targetKey: result.budget.targetKey,
        cny: hasCny ? cny : 0,
        tokens: hasTokens ? Math.trunc(tokens) : 0,
        reason,
        actor: "operator:api",
      },
    });
  } catch (error) {
    console.error(
      `[budgets] failed to write increase audit: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return NextResponse.json({
    ok: true,
    budget: toBudgetView(result.budget),
  });
}
