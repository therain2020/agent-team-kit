import { sameOriginError } from "@/lib/http";
import { ackOpsAlert } from "@/lib/ops";
import { NextResponse } from "next/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ alertId: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  const { alertId } = await params;
  let actor = "operator";
  try {
    const body = (await request.json()) as { actor?: unknown };
    if (typeof body.actor === "string" && body.actor.trim()) {
      actor = body.actor.trim();
    }
  } catch {
    // Body is optional for acknowledgements.
  }

  try {
    const alert = await ackOpsAlert(alertId, actor);
    if (!alert) {
      return NextResponse.json({ error: "alert not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, alert });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "failed to acknowledge",
      },
      { status: 500 },
    );
  }
}
