import { loadAutopilotOverview } from "@/lib/autopilot";
import { sameOriginError } from "@/lib/http";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { ensureState, saveState } from "@kit/autopilot";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    return NextResponse.json(await loadAutopilotOverview());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "load failed" },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  let body: { packDir?: unknown; enabled?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.packDir !== "string" || typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "packDir and enabled are required" },
      { status: 400 },
    );
  }
  if (
    body.packDir.includes("..") ||
    body.packDir.includes("/") ||
    body.packDir.includes("\\")
  ) {
    return NextResponse.json({ error: "invalid packDir" }, { status: 400 });
  }

  await ensureStoreSchema();
  const store = getStore();
  const state = await ensureState(
    store.autopilotState,
    "default",
    body.packDir,
    false,
  );
  const saved = {
    ...state,
    enabled: body.enabled,
    updatedAt: new Date().toISOString(),
  };
  await saveState(store.autopilotState, saved);
  return NextResponse.json({
    ok: true,
    packDir: body.packDir,
    enabled: body.enabled,
  });
}
