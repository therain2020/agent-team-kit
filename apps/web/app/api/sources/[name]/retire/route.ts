import { sameOriginError } from "@/lib/http";
import { sourceErrorResponse } from "@/lib/sources";
import { retireSource } from "@kit/source";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Retire a source: collection stops, but the manifest, meta record, raw
 * captures and audit stay on disk (98 §3.4, 10 §3.6). Never deletes history.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  const { name: rawName } = await params;
  let body: {
    reason?: unknown;
    proposalId?: unknown;
    evidence?: unknown;
    actor?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    const retired = await retireSource({
      name: decodeURIComponent(rawName),
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      ...(typeof body.proposalId === "string"
        ? { proposalId: body.proposalId }
        : {}),
      ...(isEvidence(body.evidence) ? { evidence: body.evidence } : {}),
      ...(typeof body.actor === "string" ? { actor: body.actor } : {}),
    });
    return NextResponse.json({
      ok: true,
      name: retired.meta.name,
      retiredAt: retired.meta.retiredAt,
      retirement: retired.meta.retirement,
    });
  } catch (error) {
    return sourceErrorResponse(error);
  }
}

function isEvidence(value: unknown): value is Record<string, number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (item) => typeof item === "number" || typeof item === "boolean",
  );
}
