import { sameOriginError } from "@/lib/http";
import { emitOpsAlert, loadOpsAlerts } from "@/lib/ops";
import { parseAlertTier } from "@kit/ops";
import { NextResponse } from "next/server";

const STATUSES = new Set(["open", "acknowledged", "resolved"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status") ?? undefined;
  const tierParam = url.searchParams.get("tier") ?? undefined;
  const limitParam = Number(url.searchParams.get("limit") ?? 50);

  try {
    const alerts = await loadOpsAlerts({
      status:
        statusParam && STATUSES.has(statusParam)
          ? (statusParam as "open" | "acknowledged" | "resolved")
          : undefined,
      tier: tierParam ? (parseAlertTier(tierParam) ?? undefined) : undefined,
      limit: Number.isFinite(limitParam) ? limitParam : 50,
    });
    return NextResponse.json({ alerts });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "failed to list" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (body.confirm !== true) {
    return NextResponse.json(
      { error: "confirm=true is required to inject an alert" },
      { status: 400 },
    );
  }
  const tier = parseAlertTier(body.tier);
  if (!tier) {
    return NextResponse.json({ error: "tier must be P0–P3" }, { status: 400 });
  }
  if (typeof body.kind !== "string" || typeof body.title !== "string") {
    return NextResponse.json(
      { error: "kind and title are required" },
      { status: 400 },
    );
  }

  try {
    const result = await emitOpsAlert({
      tier,
      kind: body.kind,
      title: body.title,
      body: typeof body.body === "string" ? body.body : undefined,
      dedupeKey:
        typeof body.dedupeKey === "string" ? body.dedupeKey : undefined,
      runId: typeof body.runId === "string" ? body.runId : undefined,
      stageId: typeof body.stageId === "string" ? body.stageId : undefined,
      requestId:
        typeof body.requestId === "string" ? body.requestId : undefined,
      source: typeof body.source === "string" ? body.source : "api",
      runbookUrl:
        typeof body.runbookUrl === "string" ? body.runbookUrl : undefined,
    });
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "failed to emit" },
      { status: 500 },
    );
  }
}
