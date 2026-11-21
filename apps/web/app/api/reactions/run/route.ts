import { sameOriginError } from "@/lib/http";
import { runReactions } from "@/lib/reactions";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/reactions/run` { eventId } → evaluate one stored event.
 *
 * Dispatch still goes through `fireTrigger` and the D-66 gate order; this
 * endpoint only supplies the observer-triggered evaluation.
 */
export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: { eventId?: unknown; workspaceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.eventId !== "string" || !body.eventId.trim()) {
    return NextResponse.json({ error: "eventId is required" }, { status: 400 });
  }

  try {
    const outcome = await runReactions(
      body.eventId,
      typeof body.workspaceId === "string" && body.workspaceId
        ? body.workspaceId
        : "default",
    );
    return NextResponse.json(outcome, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "failed to run reactions";
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 500 },
    );
  }
}
