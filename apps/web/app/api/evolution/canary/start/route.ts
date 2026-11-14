import path from "node:path";
import { sameOriginError } from "@/lib/http";
import { getRepoRoot, resolveVariantDir } from "@/lib/paths";
import { startCanary } from "@kit/evolution";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    baselineDir?: unknown;
    variantDir?: unknown;
    percent?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (
    typeof body.baselineDir !== "string" ||
    typeof body.variantDir !== "string"
  ) {
    return NextResponse.json(
      { error: "baselineDir and variantDir are required" },
      { status: 400 },
    );
  }
  const baseline = resolveVariantDir(body.baselineDir);
  const variant = resolveVariantDir(body.variantDir);
  if (!baseline || !variant) {
    return NextResponse.json(
      { error: "baseline and variant must be under variants/" },
      { status: 400 },
    );
  }

  const percent = typeof body.percent === "number" ? body.percent : 20;
  const statePath = path.join(getRepoRoot(), "variants", "state.json");

  try {
    const state = await startCanary(baseline, variant, percent, statePath);
    return NextResponse.json({ ok: true, state });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "canary start failed",
      },
      { status: 400 },
    );
  }
}
