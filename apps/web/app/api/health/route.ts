import { getHealth } from "@/lib/health";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = await getHealth();
    return NextResponse.json(health, {
      status: health.ok ? 200 : 503,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        db: "error",
        temporal: "error",
        worker: "unknown",
        blobBackend: "unknown",
        checkedAt: new Date().toISOString(),
        errors: [error instanceof Error ? error.message : String(error)],
      },
      { status: 503 },
    );
  }
}
