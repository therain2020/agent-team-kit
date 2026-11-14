import { JobError } from "@kit/job";
import { NextResponse } from "next/server";

export function liveGateError(mode: unknown): string | null {
  if (mode !== "LIVE") {
    return null;
  }
  return process.env.KIT_UI_ALLOW_LIVE === "1"
    ? null
    : "LIVE runs are disabled from the console; set KIT_UI_ALLOW_LIVE=1 to enable";
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
