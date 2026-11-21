import { sameOriginError } from "@/lib/http";
import { draftReaction } from "@/lib/reactions";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/reactions/draft` { intent, ruleId? } → heuristic rule draft (D-64).
 *
 * Nothing is persisted here: the editor applies the returned object only after
 * the observer reviews and saves it. A model never starts a job or edits a rule
 * through this endpoint.
 */
export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: { intent?: unknown; ruleId?: unknown; workspaceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const intent = typeof body.intent === "string" ? body.intent.trim() : "";
  if (!intent) {
    return NextResponse.json(
      { error: "describe the reaction in one sentence" },
      { status: 400 },
    );
  }

  try {
    const draft = await draftReaction({
      intent,
      ...(typeof body.ruleId === "string" && body.ruleId
        ? { ruleId: body.ruleId }
        : {}),
      ...(typeof body.workspaceId === "string" && body.workspaceId
        ? { workspaceId: body.workspaceId }
        : {}),
    });
    return NextResponse.json(draft);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "failed to draft reaction",
      },
      { status: 500 },
    );
  }
}
