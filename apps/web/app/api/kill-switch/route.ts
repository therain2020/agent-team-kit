import { sameOriginError } from "@/lib/http";
import { loadKillSwitchState } from "@/lib/kill-switch";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { killSwitchScopeSchema } from "@kit/core";
import { activateKillSwitch, releaseKillSwitch } from "@kit/engine";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await loadKillSwitchState());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "load failed" },
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
    scope?: unknown;
    target?: unknown;
    workspaceId?: unknown;
    switchId?: unknown;
    reason?: unknown;
    confirm?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (body.action !== "activate" && body.action !== "release") {
    return NextResponse.json(
      { error: "action must be activate or release" },
      { status: 400 },
    );
  }
  if (body.confirm !== true) {
    return NextResponse.json(
      { error: "explicit confirmation is required" },
      { status: 400 },
    );
  }
  if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return NextResponse.json({ error: "reason is required" }, { status: 400 });
  }

  await ensureStoreSchema();
  const store = getStore();

  try {
    if (body.action === "activate") {
      const scope = killSwitchScopeSchema.safeParse(body.scope);
      if (!scope.success) {
        return NextResponse.json({ error: "invalid scope" }, { status: 400 });
      }
      const killSwitch = await activateKillSwitch(store, {
        scope: scope.data,
        target: typeof body.target === "string" ? body.target : undefined,
        workspaceId:
          typeof body.workspaceId === "string" ? body.workspaceId : undefined,
        reason: body.reason.trim().slice(0, 2000),
        actor: "operator:web",
        role: "operator",
      });
      return NextResponse.json({ ok: true, switch: killSwitch });
    }

    if (typeof body.switchId !== "string" || body.switchId.length === 0) {
      return NextResponse.json(
        { error: "switchId is required" },
        { status: 400 },
      );
    }
    const killSwitch = await releaseKillSwitch(store, {
      switchId: body.switchId,
      reason: body.reason.trim().slice(0, 2000),
      actor: "operator:web",
      role: "operator",
    });
    return NextResponse.json({ ok: true, switch: killSwitch });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/.test(message)
      ? 404
      : /only the operator|security alert/.test(message)
        ? 403
        : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
