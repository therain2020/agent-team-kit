import { sameOriginError } from "@/lib/http";
import { loadOpsConsole, saveOpsConsolePolicy } from "@/lib/ops";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const { policy, gate } = await loadOpsConsole();
    return NextResponse.json({ policy, gate });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "failed to load" },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const result = await saveOpsConsolePolicy(body);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "invalid policy" },
      { status: 400 },
    );
  }
}
