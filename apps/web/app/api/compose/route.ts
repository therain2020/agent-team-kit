import { sameOriginError } from "@/lib/http";
import { jobErrorResponse } from "@/lib/job-api";
import { getRepoRoot } from "@/lib/paths";
import { type ComposeKind, composeJob } from "@kit/job";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    kind?: unknown;
    intent?: unknown;
    packDir?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const kind = parseKind(body.kind);
  if (!kind) {
    return NextResponse.json(
      {
        error:
          "kind must be mission, packRun, approvalPolicy, autopilot, or evolutionCycle",
      },
      { status: 400 },
    );
  }
  if (typeof body.packDir !== "string" || !body.packDir.trim()) {
    return NextResponse.json({ error: "packDir is required" }, { status: 400 });
  }

  try {
    const result = await composeJob({
      kind,
      intent: typeof body.intent === "string" ? body.intent : "",
      packDir: body.packDir,
      repoRoot: getRepoRoot(),
    });
    return NextResponse.json(result);
  } catch (error) {
    return jobErrorResponse(error);
  }
}

function parseKind(value: unknown): ComposeKind | undefined {
  return value === "mission" ||
    value === "packRun" ||
    value === "approvalPolicy" ||
    value === "autopilot" ||
    value === "evolutionCycle"
    ? value
    : undefined;
}
