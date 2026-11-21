import { sameOriginError } from "@/lib/http";
import { getRepoRoot, resolvePackDir } from "@/lib/paths";
import { ensureStoreSchema, getStore } from "@/lib/store";
import {
  type EventRoute,
  type Trigger,
  eventRouteSchema,
  fireTrigger,
  loadTriggerPlane,
  registryFromPlane,
  triggerSchema,
} from "@kit/trigger";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  try {
    const plane = await loadTriggerPlane(getRepoRoot());
    return NextResponse.json({
      triggers: plane.triggers,
      routes: plane.routes,
      errors: plane.errors,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "load failed" },
      { status: 500 },
    );
  }
}

interface FireBody {
  triggerId?: unknown;
  packDir?: unknown;
  workflow?: unknown;
  goal?: unknown;
  dedupeKey?: unknown;
  runMode?: unknown;
  confirmLive?: unknown;
}

/**
 * Manual adapter: ad-hoc firing only produces a firing; gates, budget and the
 * job write stay in `fireTrigger` (`manual:<actor>` is the ad-hoc trigger id).
 */
export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  let body: FireBody;
  try {
    body = (await request.json()) as FireBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const repoRoot = getRepoRoot();
  await ensureStoreSchema();
  const store = getStore();
  const plane = await loadTriggerPlane(repoRoot);
  const registry = registryFromPlane(plane);
  const actor = "operator:web";

  let trigger: Trigger | undefined;
  let route: EventRoute | undefined;

  if (typeof body.triggerId === "string" && body.triggerId.length > 0) {
    const configured = plane.packs
      .flatMap((pack) =>
        pack.triggers.flatMap((item) => {
          const matched = pack.routes.find(
            (candidate) => candidate.routeId === item.routeRef,
          );
          return matched ? [{ trigger: item, route: matched }] : [];
        }),
      )
      .find((item) => item.trigger.triggerId === body.triggerId);
    if (!configured) {
      return NextResponse.json(
        { error: `unknown trigger: ${body.triggerId}` },
        { status: 404 },
      );
    }
    trigger = triggerSchema.parse({
      ...configured.trigger,
      kind: "manual",
      source: "manual",
      actor,
    });
    route = configured.route;
  } else {
    const packDir =
      typeof body.packDir === "string" ? resolvePackDir(body.packDir) : null;
    if (!packDir || typeof body.workflow !== "string") {
      return NextResponse.json(
        { error: "triggerId or packDir + workflow is required" },
        { status: 400 },
      );
    }
    const triggerId = `manual:${actor}`;
    trigger = triggerSchema.parse({
      triggerId,
      kind: "manual",
      source: "manual",
      routeRef: `manual:${packDir}`,
      actor,
    });
    route = eventRouteSchema.parse({
      routeId: `manual:${packDir}`,
      triggerRef: triggerId,
      packDir,
      jobKind: "packRun",
      workflow: body.workflow,
      ...(typeof body.goal === "string" ? { goal: body.goal } : {}),
      runMode: body.runMode === "LIVE" ? "LIVE" : "DRY_RUN",
    });
  }

  if (!trigger || !route) {
    return NextResponse.json({ error: "route not found" }, { status: 404 });
  }
  if (route.runMode === "LIVE" && body.confirmLive !== true) {
    return NextResponse.json(
      {
        error: "LIVE firing requires confirmLive: true",
        code: "confirmation_required",
      },
      { status: 400 },
    );
  }

  const triggerId = trigger.triggerId;
  const dedupeKey =
    typeof body.dedupeKey === "string" && body.dedupeKey.trim().length > 0
      ? body.dedupeKey.trim()
      : `manual:${actor}:${triggerId}:${Date.now()}`;

  const result = await fireTrigger(
    { triggerId, dedupeKey, trigger, route, originKind: "manual", actor },
    { store, repoRoot, workspaceId: "default", registry },
  );
  return NextResponse.json(result, {
    status: result.dispatch === "FAILED" ? 500 : 200,
  });
}
