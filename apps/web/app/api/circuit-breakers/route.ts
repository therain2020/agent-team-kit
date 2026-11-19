import {
  loadCircuitBreakers,
  resetCircuitBreaker,
} from "@/lib/circuit-breaker";
import { sameOriginError } from "@/lib/http";
import { circuitScopeTypeSchema } from "@kit/core";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
    return NextResponse.json(await loadCircuitBreakers(workspaceId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "load failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    action?: unknown;
    scopeType?: unknown;
    scopeKey?: unknown;
    reason?: unknown;
    confirm?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (body.action !== "reset") {
    return NextResponse.json(
      { error: "action must be reset" },
      { status: 400 },
    );
  }
  if (body.confirm !== true) {
    return NextResponse.json(
      { error: "explicit confirmation is required" },
      { status: 400 },
    );
  }
  if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return NextResponse.json({ error: "reason is required" }, { status: 400 });
  }
  if (typeof body.scopeKey !== "string" || body.scopeKey.length === 0) {
    return NextResponse.json(
      { error: "scopeKey is required" },
      { status: 400 },
    );
  }
  const scopeType = circuitScopeTypeSchema.safeParse(body.scopeType);
  if (!scopeType.success) {
    return NextResponse.json({ error: "invalid scopeType" }, { status: 400 });
  }

  try {
    const record = await resetCircuitBreaker({
      scopeType: scopeType.data,
      scopeKey: body.scopeKey,
      reason: body.reason.trim().slice(0, 2000),
    });
    if (!record) {
      return NextResponse.json(
        { error: "circuit breaker not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, breaker: record });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "reset failed" },
      { status: 400 },
    );
  }
}
