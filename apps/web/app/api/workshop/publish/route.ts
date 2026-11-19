import { sameOriginError } from "@/lib/http";
import { resolvePackDir } from "@/lib/paths";
import { ASSET_KINDS, type WorkshopManifest } from "@kit/core";
import { publishWorkshop } from "@kit/workshop";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: { dir?: unknown; kind?: unknown; write?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.dir !== "string") {
    return NextResponse.json({ error: "dir is required" }, { status: 400 });
  }
  if (
    body.kind !== undefined &&
    (typeof body.kind !== "string" ||
      !(ASSET_KINDS as readonly string[]).includes(body.kind))
  ) {
    return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  }
  const packDir = resolvePackDir(body.dir);
  if (!packDir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }

  try {
    const result = await publishWorkshop({
      dir: packDir,
      kind: body.kind as WorkshopManifest["kind"] | undefined,
      write: body.write === true,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "publish failed" },
      { status: 400 },
    );
  }
}
