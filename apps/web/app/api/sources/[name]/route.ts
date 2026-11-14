import { sameOriginError } from "@/lib/http";
import { removeSource } from "@kit/source";
import { NextResponse } from "next/server";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  const { name } = await params;
  try {
    await removeSource(decodeURIComponent(name));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "remove failed" },
      { status: 400 },
    );
  }
}
