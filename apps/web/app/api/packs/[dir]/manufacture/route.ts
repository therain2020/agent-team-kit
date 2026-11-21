import { sameOriginError } from "@/lib/http";
import { getComponentsRoot, resolvePackDir } from "@/lib/paths";
import {
  MANUFACTURE_KINDS,
  type ManufactureAssetKind,
  type ManufactureComponentRequest,
  type ManufactureDraftInput,
  ManufactureError,
  acceptManufacture,
  draftManufacture,
  dryRunManufacture,
  listManufactureProposals,
  rollbackManufacture,
} from "@kit/job";
import { listComponents, workshopComponentLibrary } from "@kit/workshop";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Asset self-manufacture API (issue #132, plan 98 §3.4, D-64).
 *
 * The model only drafts. Dry-run and accept are explicit follow-up requests;
 * accept requires a successful dry-run and, for permission expansion, an
 * explicit `approved: true`. Drafts and dry-runs only touch `.manufacture/`;
 * they never write pack assets.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ dir: string }> },
) {
  const { dir } = await params;
  const packDir = resolvePackDir(decodeURIComponent(dir));
  if (!packDir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }
  const [proposals, components] = await Promise.all([
    listManufactureProposals(packDir),
    listComponents(getComponentsRoot()).catch(() => []),
  ]);
  return NextResponse.json({
    proposals,
    components: components
      .filter((component) => component.valid)
      .map((component) => ({
        kind: component.kind,
        id: component.id,
        version: component.version,
        bound: component.bound,
      })),
  });
}

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

  const library = workshopComponentLibrary(getComponentsRoot());
  try {
    const action = body.action;
    if (action === "draft") {
      const kind = parseKind(body.kind);
      if (!kind) {
        return NextResponse.json(
          {
            error:
              "kind must be agent, manager, workflow, pipeline or component",
          },
          { status: 400 },
        );
      }
      const available = await listComponents(getComponentsRoot()).catch(
        () => [],
      );
      const availableComponents: ManufactureComponentRequest[] = available
        .filter((component) => component.valid)
        .map((component) => ({ kind: component.kind, id: component.id }));
      const agentFields = parseAgentFields(body.agentFields);
      const proposal = await draftManufacture({
        kind,
        intent: typeof body.intent === "string" ? body.intent : "",
        packDir,
        ...(typeof body.assetId === "string" ? { assetId: body.assetId } : {}),
        ...(typeof body.agentId === "string" ? { agentId: body.agentId } : {}),
        ...(Array.isArray(body.componentIds)
          ? { componentIds: parseComponents(body.componentIds) }
          : {}),
        ...(agentFields ? { agentFields } : {}),
        availableComponents,
        allowCommand: body.allowCommand === true,
      });
      return NextResponse.json(proposal, { status: 200 });
    }

    const proposalId =
      typeof body.proposalId === "string" ? body.proposalId.trim() : "";
    if (!proposalId) {
      return NextResponse.json(
        { error: "proposalId is required" },
        { status: 400 },
      );
    }

    if (action === "dry-run") {
      const proposal = await dryRunManufacture(packDir, proposalId, {
        library,
      });
      return NextResponse.json(proposal, { status: 200 });
    }
    if (action === "accept") {
      const proposal = await acceptManufacture(
        packDir,
        {
          proposalId,
          approved: body.approved === true,
          ...(typeof body.actor === "string" ? { actor: body.actor } : {}),
          ...(typeof body.note === "string" ? { note: body.note } : {}),
        },
        { library },
      );
      return NextResponse.json(proposal, { status: 200 });
    }
    if (action === "rollback") {
      const proposal = await rollbackManufacture(packDir, proposalId, {
        ...(typeof body.actor === "string" ? { actor: body.actor } : {}),
        ...(typeof body.note === "string" ? { note: body.note } : {}),
      });
      return NextResponse.json(proposal, { status: 200 });
    }

    return NextResponse.json(
      { error: "action must be draft, dry-run, accept or rollback" },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof ManufactureError) {
      return NextResponse.json(
        { error: error.message, code: error.code, issues: error.issues },
        { status: error.status },
      );
    }
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ error: "manufacture failed" }, { status: 500 });
  }
}

function parseKind(value: unknown): ManufactureAssetKind | undefined {
  return typeof value === "string" &&
    (MANUFACTURE_KINDS as readonly string[]).includes(value)
    ? (value as ManufactureAssetKind)
    : undefined;
}

function parseAgentFields(
  value: unknown,
): ManufactureDraftInput["agentFields"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const out: NonNullable<ManufactureDraftInput["agentFields"]> = {};
  if (typeof record.description === "string") {
    out.description = record.description;
  }
  if (typeof record.model === "string") {
    out.model = record.model;
  }
  if (typeof record.role === "string") {
    out.role = record.role as NonNullable<
      ManufactureDraftInput["agentFields"]
    >["role"];
  }
  if (typeof record.instructions === "string") {
    out.instructions = record.instructions;
  }
  if (Array.isArray(record.tools)) {
    out.tools = record.tools.filter(
      (tool): tool is string => typeof tool === "string",
    );
  }
  if (Array.isArray(record.skills)) {
    out.skills = record.skills.filter(
      (skill): skill is string => typeof skill === "string",
    );
  }
  if (
    record.permissions &&
    typeof record.permissions === "object" &&
    !Array.isArray(record.permissions)
  ) {
    const permissions = record.permissions as Record<string, unknown>;
    out.permissions = {
      filesystem: String(permissions.filesystem ?? "readonly"),
      network: String(permissions.network ?? "none"),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseComponents(value: unknown[]): ManufactureComponentRequest[] {
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .filter(
      (item) =>
        typeof item.kind === "string" &&
        (item.kind === "agent" ||
          item.kind === "workflow" ||
          item.kind === "toolpack" ||
          item.kind === "skillpack") &&
        typeof item.id === "string" &&
        item.id.trim().length > 0,
    )
    .map((item) => ({
      kind: item.kind as ManufactureComponentRequest["kind"],
      id: String(item.id).trim(),
    }));
}
