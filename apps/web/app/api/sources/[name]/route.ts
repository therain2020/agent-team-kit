import { readFile } from "node:fs/promises";
import { sameOriginError } from "@/lib/http";
import { sourceErrorResponse } from "@/lib/sources";
import {
  type SourceBudget,
  SourceManufactureError,
  loadInstalledSource,
  removeSource,
  setSourceBudget,
  updateSourceDefinition,
} from "@kit/source";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  try {
    const source = await loadInstalledSource(decodeURIComponent(name));
    if (!source) {
      return NextResponse.json({ error: "source not found" }, { status: 404 });
    }
    const yaml = await readFile(source.file, "utf8");
    return NextResponse.json({ yaml, meta: source.meta });
  } catch (error) {
    return sourceErrorResponse(error);
  }
}

/** Observer edit (YAML) and budget, both audited (98 I-5). */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  let body: { yaml?: unknown; budget?: unknown; actor?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const actor = typeof body.actor === "string" ? body.actor : undefined;
  const yaml =
    typeof body.yaml === "string" && body.yaml.trim() ? body.yaml : "";
  if (!yaml && body.budget === undefined) {
    return NextResponse.json(
      { error: "yaml or budget is required" },
      { status: 400 },
    );
  }
  try {
    // Validate the budget before writing the YAML so a bad budget never
    // leaves a half-applied edit.
    const budget =
      body.budget === undefined ? undefined : parseBudget(body.budget);
    if (yaml) {
      await updateSourceDefinition({
        name,
        yaml,
        ...(actor ? { actor } : {}),
      });
    }
    if (budget) {
      await setSourceBudget({
        name,
        budget,
        ...(actor ? { actor } : {}),
      });
    }
    const updated = await loadInstalledSource(name);
    return NextResponse.json({
      ok: true,
      name,
      meta: updated?.meta ?? null,
    });
  } catch (error) {
    return sourceErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  const { name } = await params;
  try {
    await removeSource(decodeURIComponent(name));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "remove failed" },
      { status: 400 },
    );
  }
}

function parseBudget(value: unknown): SourceBudget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SourceManufactureError(
      "invalid_budget",
      "budget must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  const dailyCostCny = Number(record.dailyCostCny);
  const maxItemsPerRun = Number(record.maxItemsPerRun);
  if (!Number.isFinite(dailyCostCny) || dailyCostCny < 0) {
    throw new SourceManufactureError(
      "invalid_budget",
      "budget.dailyCostCny must be a non-negative number",
    );
  }
  if (
    !Number.isInteger(maxItemsPerRun) ||
    maxItemsPerRun < 1 ||
    maxItemsPerRun > 100
  ) {
    throw new SourceManufactureError(
      "invalid_budget",
      "budget.maxItemsPerRun must be an integer between 1 and 100",
    );
  }
  return { dailyCostCny, maxItemsPerRun };
}
