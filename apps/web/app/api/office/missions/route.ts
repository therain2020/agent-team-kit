import { readOnlyBlockMessage } from "@/lib/degradation";
import { sameOriginError } from "@/lib/http";
import { jobErrorResponse } from "@/lib/job-api";
import { getRepoRoot } from "@/lib/paths";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { startJob } from "@kit/job";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    packDir?: unknown;
    workflow?: unknown;
    manager?: unknown;
    agents?: unknown;
    sellers?: unknown;
    builders?: unknown;
    specialists?: unknown;
    goal?: unknown;
    acceptance?: unknown;
    evidenceText?: unknown;
    stub?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (typeof body.packDir !== "string") {
    return NextResponse.json({ error: "packDir is required" }, { status: 400 });
  }

  try {
    await ensureStoreSchema();
    const blocked = await readOnlyBlockMessage();
    if (blocked) {
      return NextResponse.json({ error: blocked }, { status: 423 });
    }
    const result = await startJob(
      getStore(),
      {
        kind: "packRun",
        origin: "web",
        packDir: body.packDir,
        runMode: "DRY_RUN",
        goal: typeof body.goal === "string" ? body.goal : undefined,
        acceptance:
          typeof body.acceptance === "string" ? body.acceptance : undefined,
        workflow: typeof body.workflow === "string" ? body.workflow : undefined,
        evidenceText:
          typeof body.evidenceText === "string" ? body.evidenceText : undefined,
        stub: body.stub === true,
        mission: {
          manager: typeof body.manager === "string" ? body.manager : undefined,
          agents: stringList(body.agents),
          sellers: stringList(body.sellers),
          builders: stringList(body.builders),
          specialists: stringList(body.specialists),
        },
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
        mission: result.mission,
      },
      { status: 202 },
    );
  } catch (error) {
    return jobErrorResponse(error);
  }
}
