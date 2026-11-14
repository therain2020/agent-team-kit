import { existsSync } from "node:fs";
import path from "node:path";
import { sameOriginError } from "@/lib/http";
import { resolvePackDir, resolveVariantDir } from "@/lib/paths";
import { promoteVariant } from "@kit/evolution";
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
    const result = await promoteVariant(variantDir, targetDir, apply);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "promotion failed",
      },
      { status: 400 },
    );
  }
}
