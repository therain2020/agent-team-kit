import { previewWorkshop } from "@kit/workshop";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const repo = url.searchParams.get("repo");
  const ref = url.searchParams.get("ref") ?? undefined;
  if (!repo) {
    return NextResponse.json({ error: "repo is required" }, { status: 400 });
  }

  try {
    const preview = await previewWorkshop({
      repo,
      ref,
      token: process.env.GITHUB_TOKEN,
    });
    return NextResponse.json(preview);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "preview failed" },
      { status: 400 },
    );
  }
}
