import { existsSync } from "node:fs";
import path from "node:path";
import { getEvolutionRepo } from "@/lib/evolution-repo";
import { sameOriginError } from "@/lib/http";
import { resolvePackDir, resolveVariantDir } from "@/lib/paths";
import { getStore } from "@/lib/store";
import {
  PromotionGateError,
  type WorkspaceExemption,
  isVariantKind,
  loadPromotionApprovals,
  markCanaryPromoted,
  promoteVariant,
  readVariantMeta,
  requestPromotionApprovals,
  resolveVariantKind,
  validateVariantNonLive,
} from "@kit/evolution";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    variantDir?: unknown;
    targetDir?: unknown;
    apply?: unknown;
    confirmation?: unknown;
    kind?: unknown;
    requestApprovals?: unknown;
    exemption?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (
    typeof body.variantDir !== "string" ||
    typeof body.targetDir !== "string"
  ) {
    return NextResponse.json(
      { error: "variantDir and targetDir are required" },
      { status: 400 },
    );
  }
  if (body.kind !== undefined && !isVariantKind(body.kind)) {
    return NextResponse.json(
      { error: "kind must be context, tool, or architecture" },
      { status: 400 },
    );
  }
  const variantDir = resolveVariantDir(body.variantDir);
  const targetDir = resolvePackDir(body.targetDir);
  if (!variantDir || !existsSync(path.join(variantDir, "variant.json"))) {
    return NextResponse.json(
      { error: "variant not found under variants/" },
      { status: 404 },
    );
  }
  if (!targetDir || !existsSync(path.join(targetDir, "team.yaml"))) {
    return NextResponse.json(
      { error: "target pack not found under packs/" },
      { status: 404 },
    );
  }

  const apply = body.apply === true;
  if (apply && body.confirmation !== "PROMOTE") {
    return NextResponse.json(
      { error: 'apply requires confirmation "PROMOTE"' },
      { status: 400 },
    );
  }

  try {
    const repo = await getEvolutionRepo();
    const store = getStore();
    const meta = await readVariantMeta(variantDir);
    const kind = resolveVariantKind({
      ...(meta.kind ? { kind: meta.kind } : {}),
      ...(isVariantKind(body.kind) ? { kind: body.kind } : {}),
      changedFiles: meta.changedFiles,
    });
    const variantWorkspaceId = meta.workspaceId ?? repo.workspaceId;
    const targetWorkspaceId = repo.workspaceId;

    if (body.requestApprovals === true) {
      const queued = await requestPromotionApprovals(store.approvals, {
        workspaceId: targetWorkspaceId,
        variantId: meta.id,
        variantKind: kind,
        targetDir,
        requester: "operator:web",
      });
      return NextResponse.json({
        ok: true,
        requested: queued.map((record) => ({
          approvalId: record.approvalId,
          role: record.requiredRole,
          status: record.status,
        })),
      });
    }

    const approvals = await loadPromotionApprovals(store.approvals, {
      workspaceId: targetWorkspaceId,
      variantId: meta.id,
      targetDir,
    });
    const validation =
      kind === "architecture" ? await validateVariantNonLive(variantDir) : null;
    const exemption = parseExemption(
      body.exemption,
      meta.id,
      variantWorkspaceId,
      targetWorkspaceId,
    );

    const result = await promoteVariant(variantDir, targetDir, apply, repo, {
      kind,
      variantWorkspaceId,
      targetWorkspaceId,
      approvals,
      exemption,
      validation,
      actor: "operator:web",
    });

    let state: Awaited<ReturnType<typeof markCanaryPromoted>> | undefined;
    let stateError: string | undefined;
    if (apply) {
      const stored = await repo.getState();
      if (
        stored?.state.canary &&
        path.resolve(stored.state.canary.path) === path.resolve(variantDir)
      ) {
        try {
          state = await markCanaryPromoted(
            `promoted to ${path.basename(targetDir)} from console`,
            { repo },
          );
        } catch (error) {
          stateError =
            error instanceof Error ? error.message : "state update failed";
        }
      }
    }

    return NextResponse.json({
      ok: true,
      ...result,
      ...(state ? { state } : {}),
      ...(stateError ? { stateError } : {}),
    });
  } catch (error) {
    if (error instanceof PromotionGateError) {
      return NextResponse.json(
        { error: error.message, code: error.code, gate: error.decision },
        { status: 403 },
      );
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "promotion failed",
      },
      { status: 400 },
    );
  }
}

/**
 * Cross-workspace reuse is denied by default; an exemption is only honoured
 * when it is explicit, attributable and matches this variant and workspace
 * pair, and it is recorded on the promotion decision.
 */
function parseExemption(
  raw: unknown,
  variantId: string,
  fromWorkspaceId: string,
  toWorkspaceId: string,
): WorkspaceExemption | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (
    typeof value.exemptionId !== "string" ||
    !value.exemptionId.trim() ||
    typeof value.reason !== "string" ||
    !value.reason.trim() ||
    typeof value.approvedBy !== "string" ||
    !value.approvedBy.trim()
  ) {
    return null;
  }
  return {
    exemptionId: value.exemptionId,
    variantId,
    fromWorkspaceId,
    toWorkspaceId,
    reason: value.reason,
    approvedBy: value.approvedBy,
    approvedAt:
      typeof value.approvedAt === "string"
        ? value.approvedAt
        : new Date().toISOString(),
  };
}
