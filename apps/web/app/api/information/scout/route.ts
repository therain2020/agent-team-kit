import { sameOriginError } from "@/lib/http";
import { runInterestScout } from "@/lib/scout";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * `POST /api/information/scout` { intent } → active research pass.
 *
 * The one-line interest is turned into read-only search/repo/doc tool calls;
 * resulting items enter the same `information.*` pipeline as passive
 * subscriptions. Network egress is gated by `KIT_SCOUT_ALLOW_NETWORK`, never by
 * this request body.
 */
export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: { intent?: unknown; workspaceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const intent = typeof body.intent === "string" ? body.intent.trim() : "";
  if (!intent) {
    return NextResponse.json(
      { error: "describe what to research in one sentence" },
      { status: 400 },
    );
  }
  if (intent.length > 400) {
    return NextResponse.json(
      { error: "intent must be 400 characters or fewer" },
      { status: 400 },
    );
  }
  const workspaceId =
    typeof body.workspaceId === "string" && body.workspaceId
      ? body.workspaceId
      : "default";

  try {
    const result = await runInterestScout(intent, workspaceId);
    return NextResponse.json({
      ok: true,
      runId: result.runId,
      allowNetwork: result.allowNetwork,
      queries: result.queries,
      warnings: result.warnings,
      ingested: {
        items: result.items.length,
        eventsCreated: result.ingested.eventsCreated,
        scored: result.ingested.scored,
        duplicates: result.ingested.duplicates,
      },
      toolCalls: result.toolCalls.map((call) => ({
        tool: call.tool,
        risk: call.risk,
        ok: call.ok,
        durationMs: call.durationMs,
        injectionSuspected: call.injectionSuspected,
        ...(call.error ? { error: call.error } : {}),
      })),
      items: result.items.slice(0, 10).map((item) => ({
        sourceId: item.sourceId,
        title: item.title,
        url: item.url,
        ...(item.summary ? { summary: item.summary } : {}),
        ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
      })),
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "scout run failed",
      },
      { status: code === "scout_permission_denied" ? 403 : 500 },
    );
  }
}
