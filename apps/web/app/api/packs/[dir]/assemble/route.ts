import path from "node:path";
import { recordGateEvidenceSafely } from "@/lib/gate-evidence";
import { sameOriginError } from "@/lib/http";
import { getComponentsRoot, resolvePackDir } from "@/lib/paths";
import { GATE_EVIDENCE_KIND } from "@kit/activity";
import { COMPONENT_KINDS, type ComponentKind } from "@kit/core";
import {
  AssemblyError,
  type ComponentRequest,
  assembleComponents,
} from "@kit/pack";
import { workshopComponentLibrary } from "@kit/workshop";
import { NextResponse } from "next/server";

/**
 * Deterministic component assembly for the Studio pipeline composer (plan 88
 * §3.1 / M3b, feeds 94 C-6c). No AI: the caller names the components and the
 * server binds them into the pack atomically and records them in the lockfile.
 *
 * `dryRun: true` validates the same request end to end and returns the plan
 * without writing, so the review step can re-check operator edits before the
 * single approval click.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ dir: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  const { dir } = await params;
  const packDir = resolvePackDir(decodeURIComponent(dir));
  if (!packDir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const raw = Array.isArray(body.components) ? body.components : [];
  const components: ComponentRequest[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      return NextResponse.json({ error: "invalid component" }, { status: 400 });
    }
    const kind = (entry as Record<string, unknown>).kind;
    const id = (entry as Record<string, unknown>).id;
    if (
      typeof kind !== "string" ||
      !(COMPONENT_KINDS as readonly string[]).includes(kind) ||
      typeof id !== "string" ||
      !id.trim()
    ) {
      return NextResponse.json(
        { error: "each component needs a valid kind and id" },
        { status: 400 },
      );
    }
    components.push({ kind: kind as ComponentKind, id: id.trim() });
  }
  if (components.length === 0) {
    return NextResponse.json({ error: "no components" }, { status: 400 });
  }

  try {
    const result = await assembleComponents(
      {
        packDir,
        components,
        allowCommand: body.allowCommand === true,
        dryRun: body.dryRun === true,
      },
      workshopComponentLibrary(getComponentsRoot()),
    );
    // Workshop evidence (85 §5.2 S10): components were bound into a pack from
    // the local library and recorded in the lockfile. Best-effort audit only.
    await recordGateEvidenceSafely({
      agentId: "operator",
      kind: GATE_EVIDENCE_KIND.workshopComponentAssembled,
      status: "completed",
      summary: `assembled ${components.length} component(s) into ${path.basename(packDir)}`,
      payload: {
        pack: path.basename(packDir),
        components,
      },
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof AssemblyError) {
      return NextResponse.json(
        {
          error: error.message,
          issues: error.issues,
          warnings: error.warnings,
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "assembly failed" },
      { status: 400 },
    );
  }
}
