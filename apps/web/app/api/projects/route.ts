import { getRepoRoot } from "@/lib/paths";
import { listProjects } from "@kit/job";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const projects = await listProjects(getRepoRoot());
    return NextResponse.json({
      projects,
      liveAllowed: process.env.KIT_UI_ALLOW_LIVE === "1",
      projectsRoot: process.env.KIT_PROJECTS_ROOT ?? null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "failed to list projects",
      },
      { status: 500 },
    );
  }
}
