import path from "node:path";
import { getEvolutionRepo } from "@/lib/evolution-repo";
import { sameOriginError } from "@/lib/http";
import { getRepoRoot } from "@/lib/paths";
import { setCanaryTraffic } from "@kit/evolution";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: { percent?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (typeof body.percent !== "number") {
    return NextResponse.json(
      { error: "percent must be a number between 0 and 99" },
      { status: 400 },
    );
  }

  const statePath = path.join(getRepoRoot(), "variants", "state.json");

  try {
    const state = await setCanaryTraffic(body.percent, {
      statePath,
      repo: await getEvolutionRepo(),
    });
    return NextResponse.json({ ok: true, state });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "traffic update failed",
      },
      { status: 409 },
    );
  }
}
