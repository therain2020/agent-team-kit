import { sameOriginError } from "@/lib/http";
import { sourceErrorResponse } from "@/lib/sources";
import { installSourceProposal } from "@kit/source";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The only path that writes an AI-drafted source into `sources/`. Requires
 * `approved: true` from the observer; endpoint/secret/trust are re-checked.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  const { id } = await params;
  let body: { approved?: unknown; yaml?: unknown; actor?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    const installed = await installSourceProposal({
      id: decodeURIComponent(id),
      approved: body.approved === true,
      ...(typeof body.yaml === "string" ? { yaml: body.yaml } : {}),
      ...(typeof body.actor === "string" ? { actor: body.actor } : {}),
    });
    return NextResponse.json({
      ok: true,
      proposal: installed.proposal,
      name: installed.installed.definition.metadata.name,
      version: installed.installed.definition.metadata.version,
      file: installed.installed.file,
      trust: installed.installed.meta.trust,
    });
  } catch (error) {
    return sourceErrorResponse(error);
  }
}
