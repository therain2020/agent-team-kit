import { ensureStoreSchema, getStore } from "@/lib/store";
import {
  DEFAULT_WORKSPACE_ID,
  getActiveAutonomyPreset,
  getOpsGate,
} from "@kit/ops";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureStoreSchema();
    const store = getStore();
    const [preset, gate] = await Promise.all([
      getActiveAutonomyPreset(store, DEFAULT_WORKSPACE_ID),
      getOpsGate(store, new Date(), DEFAULT_WORKSPACE_ID),
    ]);
    return NextResponse.json({
      level: preset ? preset.level : "manual",
      preset,
      gate,
      liveAllowed: process.env.KIT_UI_ALLOW_LIVE === "1" || preset !== null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "failed to load autonomy status",
      },
      { status: 500 },
    );
  }
}
