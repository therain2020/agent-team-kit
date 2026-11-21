import { sameOriginError } from "@/lib/http";
import { sourceErrorResponse } from "@/lib/sources";
import { loadSourceProposal, reviseSourceProposal } from "@kit/source";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const proposal = await loadSourceProposal(decodeURIComponent(id));
  return proposal
    ? NextResponse.json(proposal)
    : NextResponse.json({ error: "proposal not found" }, { status: 404 });
}

/** Observer edit: re-run the full gate on the edited YAML. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  const { id } = await params;
  let body: { yaml?: unknown; actor?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.yaml !== "string" || !body.yaml.trim()) {
    return NextResponse.json({ error: "yaml is required" }, { status: 400 });
  }
  try {
    const proposal = await reviseSourceProposal({
      id: decodeURIComponent(id),
      yaml: body.yaml,
      ...(typeof body.actor === "string" ? { actor: body.actor } : {}),
    });
    return NextResponse.json(proposal);
  } catch (error) {
    return sourceErrorResponse(error);
  }
}
