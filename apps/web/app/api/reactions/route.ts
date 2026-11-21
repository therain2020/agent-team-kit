import { sameOriginError } from "@/lib/http";
import {
  loadReactionsView,
  saveReactionRule,
  setReactionRuleEnabled,
} from "@/lib/reactions";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET /api/reactions` → current rules, audit trail, usage and recent firings. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId") || "default";
  try {
    const view = await loadReactionsView(workspaceId);
    return NextResponse.json(
      {
        workspaceId: view.workspaceId,
        rules: view.rules,
        audit: view.audit,
        reactions: view.reactions,
        usage: view.usage,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "failed to load reactions",
      },
      { status: 500 },
    );
  }
}

/** `PUT /api/reactions` → append a new rule version plus audit (observer). */
export async function PUT(request: Request) {
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
  const workspaceId = workspaceFrom(body);

  try {
    const rule = await saveReactionRule(body, workspaceId);
    return NextResponse.json({ ok: true, rule }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "failed to save reaction rule");
  }
}

/** `PATCH /api/reactions` → enable/disable a rule with a required rationale. */
export async function PATCH(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    ruleId?: unknown;
    enabled?: unknown;
    rationale?: unknown;
    expectedVersion?: unknown;
    workspaceId?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.ruleId !== "string" || !body.ruleId.trim()) {
    return NextResponse.json({ error: "ruleId is required" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be boolean" },
      { status: 400 },
    );
  }
  const rationale =
    typeof body.rationale === "string" ? body.rationale.trim() : "";
  if (!rationale) {
    return NextResponse.json(
      { error: "a one-sentence rationale is required" },
      { status: 400 },
    );
  }
  const expectedVersion =
    typeof body.expectedVersion === "number" &&
    Number.isInteger(body.expectedVersion) &&
    body.expectedVersion >= 0
      ? body.expectedVersion
      : undefined;

  try {
    const rule = await setReactionRuleEnabled({
      workspaceId:
        typeof body.workspaceId === "string" && body.workspaceId
          ? body.workspaceId
          : "default",
      ruleId: body.ruleId,
      enabled: body.enabled,
      rationale,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
    return NextResponse.json({ ok: true, rule });
  } catch (error) {
    return errorResponse(error, "failed to update reaction rule");
  }
}

function workspaceFrom(body: unknown): string {
  if (body && typeof body === "object") {
    const value = (body as { workspaceId?: unknown }).workspaceId;
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return "default";
}

function errorResponse(error: unknown, fallback: string) {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  const status =
    code === "reaction_rule_version_conflict"
      ? 409
      : code === "reaction_rule_requires_approval"
        ? 403
        : 400;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status },
  );
}
