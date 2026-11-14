import { sameOriginError } from "@/lib/http";
import { getRepoRoot } from "@/lib/paths";
import { runAutopilotTick } from "@kit/autopilot";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: { dryRun?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    const result = await runAutopilotTick({
      repoRoot: getRepoRoot(),
      dryRun: body.dryRun === true,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "tick failed" },
      { status: 500 },
    );
  }
}
