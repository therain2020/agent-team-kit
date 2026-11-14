import { sameOriginError } from "@/lib/http";
import { jobErrorResponse, liveGateError } from "@/lib/job-api";
import { getRepoRoot } from "@/lib/paths";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { startJob } from "@kit/job";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    packDir?: unknown;
    workflow?: unknown;
    stub?: unknown;
    evidenceArtifactId?: unknown;
    evidenceText?: unknown;
    mode?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const runMode =
    body.mode === "LIVE" || body.mode === "DRY_RUN" ? body.mode : "DRY_RUN";
  const gate = liveGateError(body.mode);
  if (gate) {
    return NextResponse.json({ error: gate }, { status: 403 });
  }
  if (typeof body.packDir !== "string" || body.packDir.trim().length === 0) {
    return NextResponse.json({ error: "packDir is required" }, { status: 400 });
  }
  if (
    body.evidenceText !== undefined &&
    (typeof body.evidenceText !== "string" ||
      body.evidenceText.length > 200_000)
  ) {
    return NextResponse.json(
      { error: "evidenceText must be a string under 200k characters" },
      { status: 400 },
    );
  }

  try {
    await ensureStoreSchema();
    const result = await startJob(
      getStore(),
      {
        kind: "packRun",
        origin: "web",
        packDir: body.packDir,
        runMode,
        stub: body.stub === true,
        workflow: typeof body.workflow === "string" ? body.workflow : undefined,
        evidenceText:
          typeof body.evidenceText === "string" ? body.evidenceText : undefined,
        evidenceArtifactId:
          typeof body.evidenceArtifactId === "string"
            ? body.evidenceArtifactId
            : undefined,
      },
      { repoRoot: getRepoRoot() },
    );
    return NextResponse.json(
      {
        runId: result.jobId,
        requestId: result.requestId,
        ...(result.workflowId ? { workflowId: result.workflowId } : {}),
        engine: result.engine,
        pack: result.pack,
        workflow: result.workflow,
        stub: body.stub === true,
        evidence: Boolean(body.evidenceText || body.evidenceArtifactId),
      },
      { status: 202 },
    );
  } catch (error) {
    return jobErrorResponse(error);
  }
}
