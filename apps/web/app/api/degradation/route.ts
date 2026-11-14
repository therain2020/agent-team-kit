import { loadActiveModes, loadDegradationAudit } from "@/lib/degradation";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [modes, audit] = await Promise.all([
      loadActiveModes(),
      loadDegradationAudit(50),
    ]);
    return NextResponse.json({ modes, audit });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "failed to load degradation",
      },
      { status: 500 },
    );
  }
}
