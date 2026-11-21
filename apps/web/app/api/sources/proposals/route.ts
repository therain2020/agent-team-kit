import { sameOriginError } from "@/lib/http";
import { loadSourceProposalSurface, sourceErrorResponse } from "@/lib/sources";
import { draftAuthoredSource } from "@kit/job";
import { createSourceProposal } from "@kit/source";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Source manufacture proposals (issue #131, 98 I-5).
 *
 * GET returns observer-editable proposals plus retirement proposals derived
 * from per-source yield. POST drafts and gates a declarative `source.yaml`;
 * nothing is installed here — installation needs explicit observer approval.
 */
export async function GET() {
  try {
    return NextResponse.json(await loadSourceProposalSurface());
  } catch (error) {
    return sourceErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  let body: {
    intent?: unknown;
    yaml?: unknown;
    model?: unknown;
    rationale?: unknown;
    warnings?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const intent = typeof body.intent === "string" ? body.intent.trim() : "";
  if (!intent) {
    return NextResponse.json(
      { error: "describe the source in one sentence" },
      { status: 400 },
    );
  }
  const yaml =
    typeof body.yaml === "string" && body.yaml.trim()
      ? body.yaml
      : draftAuthoredSource(intent).yaml;
  try {
    const proposal = await createSourceProposal({
      intent,
      yaml,
      model: body.model === "live" ? "live" : "heuristic",
      ...(typeof body.rationale === "string" && body.rationale.trim()
        ? { rationale: body.rationale.trim() }
        : {}),
      ...(Array.isArray(body.warnings)
        ? {
            warnings: body.warnings.filter(
              (item): item is string => typeof item === "string",
            ),
          }
        : {}),
    });
    return NextResponse.json(proposal, { status: 201 });
  } catch (error) {
    return sourceErrorResponse(error);
  }
}
