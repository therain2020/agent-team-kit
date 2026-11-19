import { getEvolutionRepo } from "@/lib/evolution-repo";
import { sameOriginError } from "@/lib/http";
import {
  DEFAULT_CONVERGENCE_WINDOW,
  type EvolutionFreezeKind,
  convergenceGuard,
  evolutionCostReport,
  freezeEvolution,
  loadEvolutionCycles,
  loadFreezeState,
  unfreezeEvolution,
} from "@kit/evolution";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const FREEZE_KINDS: ReadonlySet<EvolutionFreezeKind> = new Set([
  "incident",
  "manual",
  "convergence",
  "divergence",
]);

export async function GET() {
  try {
    const repo = await getEvolutionRepo();
    const [freeze, cycles] = await Promise.all([
      loadFreezeState({ repo }),
      loadEvolutionCycles(undefined, 50, repo),
    ]);
    const guard = convergenceGuard(cycles, DEFAULT_CONVERGENCE_WINDOW);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const productionCostCny = await repo.sumRunCostCny(since);
    return NextResponse.json(
      {
        freeze,
        convergence: {
          window: guard.window,
          streak: guard.streak,
          wouldFreeze: guard.frozen,
          ...(guard.hint ? { hint: guard.hint } : {}),
        },
        cost: {
          since,
          ...evolutionCostReport(
            cycles.filter((cycle) => cycle.createdAt >= since),
            productionCostCny,
          ),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "status failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    action?: unknown;
    kind?: unknown;
    reason?: unknown;
    actor?: unknown;
    liftCondition?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const action = body.action;
  if (action !== "freeze" && action !== "unfreeze") {
    return NextResponse.json(
      { error: "action must be freeze or unfreeze" },
      { status: 400 },
    );
  }
  const actor =
    typeof body.actor === "string" && body.actor ? body.actor : "operator";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  try {
    const repo = await getEvolutionRepo();
    if (action === "unfreeze") {
      const state = await unfreezeEvolution(
        { ...(reason ? { reason } : {}), actor },
        { repo },
      );
      return NextResponse.json({ state }, { status: 200 });
    }
    if (!FREEZE_KINDS.has(body.kind as EvolutionFreezeKind)) {
      return NextResponse.json(
        { error: "kind must be incident, manual, convergence, or divergence" },
        { status: 400 },
      );
    }
    if (!reason) {
      return NextResponse.json(
        { error: "reason is required to freeze evolution" },
        { status: 400 },
      );
    }
    const state = await freezeEvolution(
      {
        kind: body.kind as EvolutionFreezeKind,
        reason,
        actor,
        ...(typeof body.liftCondition === "string" && body.liftCondition
          ? { liftCondition: body.liftCondition }
          : {}),
      },
      { repo },
    );
    return NextResponse.json({ state }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "freeze failed" },
      { status: 500 },
    );
  }
}
