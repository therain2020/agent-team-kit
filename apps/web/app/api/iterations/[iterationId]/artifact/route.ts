import { loadArtifactContent } from "@/lib/runs";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ iterationId: string }> },
) {
  await context.params;
  await ensureStoreSchema();
  const artifactId = new URL(request.url).searchParams.get("artifactId");
  if (!artifactId) {
    return NextResponse.json(
      { error: "artifactId is required" },
      { status: 400 },
    );
  }

  const store = getStore();
  const artifact = await store.artifactStore.findById(artifactId);
  if (!artifact) {
    return NextResponse.json({ error: "artifact not found" }, { status: 404 });
  }
  const content = await loadArtifactContent(artifact, store, 120_000);
  if (content.unavailable) {
    return NextResponse.json(
      { error: "artifact blob unavailable" },
      { status: 404 },
    );
  }
  return new NextResponse(content.text, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
