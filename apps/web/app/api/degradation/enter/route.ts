import { enterMode } from "@/lib/degradation";
import { sameOriginError } from "@/lib/http";
import { DegradationContractError } from "@kit/core";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface EnterBody {
  scope?: unknown;
  workspaceId?: unknown;
  kind?: unknown;
  dependencyId?: unknown;
  reason?: unknown;
  minChars?: unknown;
  minStableMinutes?: unknown;
  securityEvent?: unknown;
}

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: EnterBody;
  try {
    body = (await request.json()) as EnterBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const scope =
    body.scope === "global" || body.scope === "workspace" ? body.scope : null;
  const kind =
    body.kind === "degraded" || body.kind === "read_only" ? body.kind : null;
  if (!scope) {
    return NextResponse.json(
      { error: 'scope must be "workspace" or "global"' },
      { status: 400 },
    );
  }
  if (!kind) {
    return NextResponse.json(
      { error: 'kind must be "degraded" or "read_only"' },
      { status: 400 },
    );
  }
  if (
    typeof body.dependencyId !== "string" ||
    body.dependencyId.trim().length === 0
  ) {
    return NextResponse.json(
      { error: "dependencyId is required" },
      { status: 400 },
    );
  }
  if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return NextResponse.json({ error: "reason is required" }, { status: 400 });
  }

  const minChars = optionalCount(body.minChars);
  const minStableMinutes = optionalCount(body.minStableMinutes);
  if (minChars === undefined && body.minChars !== undefined) {
    return NextResponse.json(
      { error: "minChars must be a non-negative integer" },
      { status: 400 },
    );
  }
  if (minStableMinutes === undefined && body.minStableMinutes !== undefined) {
    return NextResponse.json(
      { error: "minStableMinutes must be a non-negative integer" },
      { status: 400 },
    );
  }

  try {
    const mode = await enterMode({
      scope,
      kind,
      ...(typeof body.workspaceId === "string" && body.workspaceId.trim()
        ? { workspaceId: body.workspaceId.trim() }
        : {}),
      dependencyId: body.dependencyId,
      reason: body.reason.trim(),
      ...(minChars !== undefined ? { minChars } : {}),
      ...(minStableMinutes !== undefined ? { minStableMinutes } : {}),
      securityEvent: body.securityEvent === true,
    });
    return NextResponse.json({ mode }, { status: 201 });
  } catch (error) {
    if (error instanceof DegradationContractError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        {
          status: error.code === "global_requires_security_event" ? 403 : 400,
        },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "failed to enter" },
      { status: 400 },
    );
  }
}

function optionalCount(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
