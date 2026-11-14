import { sameOriginError } from "@/lib/http";
import { testSource } from "@kit/source";
import { NextResponse } from "next/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  const { name } = await params;
  try {
    const result = await testSource(decodeURIComponent(name), { limit: 3 });
    return NextResponse.json({
      ok: true,
      items: result.items.map((item) => ({
        title: item.title,
        url: item.url,
        publishedAt: item.publishedAt,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "test failed" },
      { status: 400 },
    );
  }
}
