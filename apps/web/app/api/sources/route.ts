import { sameOriginError } from "@/lib/http";
import { loadInstalledSources, searchSourceMarket } from "@/lib/sources";
import { installSource } from "@kit/source";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? undefined;
  try {
    const [installed, candidates] = await Promise.all([
      loadInstalledSources(),
      searchSourceMarket(query),
    ]);
    return NextResponse.json({
      installed: installed.map((source) => ({
        name: source.definition.metadata.name,
        version: source.definition.metadata.version,
        description: source.definition.metadata.description ?? "",
        repo: source.meta.repo,
        commit: source.meta.commit,
        trust: source.meta.trust,
      })),
      candidates,
    });
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
    file?: unknown;
    confirm?: unknown;
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
      { error: "confirm=true is required for third-party sources" },
      { status: 400 },
    );
  }

  try {
    const installed = await installSource({
      repo: body.repo,
      ref: typeof body.ref === "string" ? body.ref : undefined,
      file: typeof body.file === "string" ? body.file : undefined,
      token: process.env.GITHUB_TOKEN,
      acceptThirdParty: true,
    });
    return NextResponse.json(
      {
        ok: true,
        name: installed.definition.metadata.name,
        version: installed.definition.metadata.version,
        repo: installed.meta.repo,
        commit: installed.meta.commit,
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
