import { loadFactorySnapshot } from "@/lib/factory-server";
import { sameOriginError } from "@/lib/http";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  const snapshot = await loadFactorySnapshot();
  return NextResponse.json(snapshot);
}
