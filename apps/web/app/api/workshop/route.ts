import { sameOriginError } from "@/lib/http";
import { resolvePackDir } from "@/lib/paths";
import {
  getWorkshopComponentsRoot,
  getWorkshopPacksRoot,
  getWorkshopSourcesRoot,
  getWorkshopTemplatesRoot,
  loadInstalledWorkshop,
  searchWorkshopMarket,
} from "@/lib/workshop";
import { installWorkshop } from "@kit/workshop";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? undefined;
  try {
    const [installed, candidates] = await Promise.all([
      loadInstalledWorkshop(),
      searchWorkshopMarket(query),
    ]);
    return NextResponse.json({ installed, candidates });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "search failed",
      },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    repo?: unknown;
    ref?: unknown;
    confirm?: unknown;
    allowCode?: unknown;
    acceptUnsigned?: unknown;
    acceptHighRisk?: unknown;
    overwrite?: unknown;
    hostPack?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.repo !== "string") {
    return NextResponse.json({ error: "repo is required" }, { status: 400 });
  }
  if (body.confirm !== true) {
    return NextResponse.json(
      { error: "confirm=true is required for third-party workshop items" },
      { status: 400 },
    );
  }

  let hostPack: string | undefined;
  if (body.hostPack !== undefined) {
    if (typeof body.hostPack !== "string") {
      return NextResponse.json(
        { error: "hostPack must be a pack name" },
        { status: 400 },
      );
    }
    const resolved = resolvePackDir(body.hostPack);
    if (!resolved) {
      return NextResponse.json(
        { error: `unknown pack: ${body.hostPack}` },
        { status: 400 },
      );
    }
    hostPack = resolved;
  }

  try {
    const installed = await installWorkshop({
      repo: body.repo,
      ref: typeof body.ref === "string" ? body.ref : undefined,
      token: process.env.GITHUB_TOKEN,
      packsRoot: getWorkshopPacksRoot(),
      sourcesRoot: getWorkshopSourcesRoot(),
      templatesRoot: getWorkshopTemplatesRoot(),
      componentsRoot: getWorkshopComponentsRoot(),
      hostPack,
      overwrite: body.overwrite === true,
      acceptThirdParty: true,
      allowCode: body.allowCode === true,
      acceptUnsigned: body.acceptUnsigned === true,
      acceptHighRisk: body.acceptHighRisk === true,
    });
    return NextResponse.json(
      {
        ok: true,
        repo: installed.repo,
        commit: installed.commit,
        id: installed.manifest.id,
        name: installed.manifest.name,
        version: installed.manifest.version,
        kind: installed.manifest.kind,
        scope: installed.scope,
        dir: installed.dir,
        manifestSha256: installed.manifestSha256,
        trust: installed.trust,
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "install failed" },
      { status: 400 },
    );
  }
}
