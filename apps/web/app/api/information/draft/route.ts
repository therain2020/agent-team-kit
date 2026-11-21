import { sameOriginError } from "@/lib/http";
import { draftProfile, loadInformationView } from "@/lib/information";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/information/draft` { intent } → heuristic profile draft (D-64).
 *
 * Nothing is persisted here: the editor applies the returned object only after
 * the observer reviews and saves it.
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
      { error: "describe what the team cares about in one sentence" },
      { status: 400 },
    );
  }

  const workspaceId =
    typeof body.workspaceId === "string" && body.workspaceId
      ? body.workspaceId
      : "default";

  try {
    const view = await loadInformationView(workspaceId);
    const draft = draftProfile(intent, view.persisted ? view.profile : null);
    return NextResponse.json({
      draft,
      rationale: draft.rationale,
      model: draft.model,
      warnings: [],
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "failed to draft profile",
      },
      { status: 500 },
    );
  }
}
