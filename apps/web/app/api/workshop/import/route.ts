import { sameOriginError } from "@/lib/http";
import { getWorkshopPacksRoot, getWorkshopRoot } from "@/lib/workshop";
import { importInstalledPack } from "@kit/workshop";
import { NextResponse } from "next/server";

/**
 * Explicit "import as pack" for pack-kind installs that still live in the
 * legacy `workshop/` directory (plan 88 §3.4). The source directory is kept;
 * this only adds a validated copy under `packs/`.
 */
export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: { id?: unknown; overwrite?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.id !== "string") {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const imported = await importInstalledPack({
      dirName: body.id,
      root: getWorkshopRoot(),
      packsRoot: getWorkshopPacksRoot(),
      overwrite: body.overwrite === true,
    });
    return NextResponse.json(
      {
        ok: true,
        id: imported.id,
        dirName: imported.dirName,
        repo: imported.repo,
        commit: imported.commit,
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "import failed" },
      { status: 400 },
    );
  }
}
