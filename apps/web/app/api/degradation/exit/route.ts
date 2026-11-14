import { exitMode } from "@/lib/degradation";
import { sameOriginError } from "@/lib/http";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface ExitBody {
  scope?: unknown;
  workspaceId?: unknown;
  reason?: unknown;
  qualityRecheck?: unknown;
  summary?: unknown;
}

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: ExitBody;
  try {
    body = (await request.json()) as ExitBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const scope =
    body.scope === "global" || body.scope === "workspace" ? body.scope : null;
  if (!scope) {
    return NextResponse.json(
      { error: 'scope must be "workspace" or "global"' },
      { status: 400 },
    );
  }
  if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return NextResponse.json(
      { error: "reason is required to exit" },
      { status: 400 },
    );
  }

  try {
    const result = await exitMode({
      scope,
      ...(typeof body.workspaceId === "string" && body.workspaceId.trim()
        ? { workspaceId: body.workspaceId.trim() }
        : {}),
      reason: body.reason.trim(),
      qualityRecheck: body.qualityRecheck === true,
      ...(typeof body.summary === "string" && body.summary.trim()
        ? { summary: body.summary.trim() }
        : {}),
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: "exit criteria not met", reasons: result.reasons },
        { status: 409 },
      );
    }
    return NextResponse.json({ mode: result.mode });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "failed to exit" },
      { status: 500 },
    );
  }
}
