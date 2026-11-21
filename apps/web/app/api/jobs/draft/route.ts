import { sameOriginError } from "@/lib/http";
import { jobErrorResponse } from "@/lib/job-api";
import { getRepoRoot } from "@/lib/paths";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { newId } from "@kit/core";
import { draftJob } from "@kit/job";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    goal?: unknown;
    projectId?: unknown;
    projectPath?: unknown;
    packDir?: unknown;
    jobId?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const jobId =
    typeof body.jobId === "string" && body.jobId.trim()
      ? body.jobId.trim()
      : newId("draft");

  try {
    await ensureStoreSchema();
    const store = getStore();
    const result = await draftJob({
      goal: typeof body.goal === "string" ? body.goal : "",
      projectId:
        typeof body.projectId === "string" ? body.projectId : undefined,
      projectPath:
        typeof body.projectPath === "string" ? body.projectPath : undefined,
      packDir: typeof body.packDir === "string" ? body.packDir : undefined,
      repoRoot: getRepoRoot(),
      cost: {
        workspaceId: "default",
        jobId,
        sink: store.costLedger,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return jobErrorResponse(error);
  }
}
