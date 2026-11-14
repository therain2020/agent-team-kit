import { JobError } from "@kit/job";
import { getActiveAutonomyPreset } from "@kit/ops";
import { NextResponse } from "next/server";
import { ensureStoreSchema, getStore } from "./store";

export async function liveGateError(mode: unknown): Promise<string | null> {
  if (mode !== "LIVE") {
    return null;
  }
  if (process.env.KIT_UI_ALLOW_LIVE === "1") {
    return null;
  }
  try {
    await ensureStoreSchema();
    if (await getActiveAutonomyPreset(getStore())) {
      return null;
    }
  } catch {
    // Fall through to the closed gate when storage is unavailable.
  }
  return "LIVE runs are disabled from the console; run `kit autonomy enable` or set KIT_UI_ALLOW_LIVE=1";
}

export function jobErrorResponse(error: unknown): NextResponse {
  if (error instanceof JobError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "job failed" },
    { status: 500 },
  );
}
