import { sameOriginError } from "@/lib/http";
import { jobErrorResponse } from "@/lib/job-api";
import { getRepoRoot } from "@/lib/paths";
import { draftJob } from "@kit/job";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: { goal?: unknown; projectId?: unknown; packDir?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const result = await draftJob({
      goal: typeof body.goal === "string" ? body.goal : "",
      projectId:
        typeof body.projectId === "string" ? body.projectId : undefined,
      packDir: typeof body.packDir === "string" ? body.packDir : undefined,
      repoRoot: getRepoRoot(),
    });
    return NextResponse.json(result);
  } catch (error) {
    return jobErrorResponse(error);
  }
}
