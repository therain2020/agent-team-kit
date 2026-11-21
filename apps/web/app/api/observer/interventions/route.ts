import { sameOriginError, tokenError } from "@/lib/http";
import {
  DEFAULT_OBSERVER_WORKSPACE,
  parseInterventionBody,
  runIntervention,
} from "@/lib/observer";
import { ensureStoreSchema, getStore } from "@/lib/store";
import {
  ObserverActionError,
  listObserverActions,
  summarizeObserverMetrics,
} from "@kit/activity";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET /api/observer/interventions` → read-only action ledger + metrics. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const workspaceId =
    url.searchParams.get("workspaceId") || DEFAULT_OBSERVER_WORKSPACE;
  try {
    await ensureStoreSchema();
    const store = getStore();
    const [actions, metrics] = await Promise.all([
      listObserverActions(store, { workspaceId, limit: 50 }),
      summarizeObserverMetrics(store, { workspaceId }),
    ]);
    return NextResponse.json(
      { workspaceId, actions, metrics },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "failed to load observer",
      },
      { status: 500 },
    );
  }
}

/**
 * `POST /api/observer/interventions` → the one controlled observer write.
 *
 * Every accepted action is executed by the plane that owns it and then recorded
 * as a single audited observer action with actor + reason. Forbidden targets or
 * actions are rejected before any side effect; a missing token is rejected when
 * `KIT_UI_TOKEN` is configured.
 */
export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  const unauthorized = tokenError(request);
  if (unauthorized) {
    return NextResponse.json({ error: unauthorized }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  let input: ReturnType<typeof parseInterventionBody>;
  try {
    input = parseInterventionBody(body);
  } catch (error) {
    if (error instanceof ObserverActionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "invalid request" },
      { status: 400 },
    );
  }

  try {
    const result = await runIntervention(input);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ObserverActionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "intervention failed",
      },
      { status: 500 },
    );
  }
}
