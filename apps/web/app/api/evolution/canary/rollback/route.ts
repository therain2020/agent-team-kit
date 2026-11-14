import path from "node:path";
import { getEvolutionRepo } from "@/lib/evolution-repo";
import { sameOriginError } from "@/lib/http";
import { getRepoRoot } from "@/lib/paths";
import { rollbackCanary } from "@kit/evolution";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: { reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.slice(0, 500)
      : "manual rollback from console";
  const statePath = path.join(getRepoRoot(), "variants", "state.json");

  try {
    const state = await rollbackCanary(reason, {
      statePath,
      repo: await getEvolutionRepo(),
    });
    return NextResponse.json({ ok: true, state });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "rollback failed",
      },
      { status: 409 },
    );
  }
}
