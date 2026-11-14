import { resolvePackDir } from "@/lib/paths";
import { validatePack } from "@kit/pack";
import { NextResponse } from "next/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ dir: string }> },
) {
  const { dir } = await params;
  const packDir = resolvePackDir(decodeURIComponent(dir));
  if (!packDir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }
  const result = await validatePack(packDir);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
