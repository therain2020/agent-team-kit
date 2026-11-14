import { sameOriginError } from "@/lib/http";
import { resolvePackDir } from "@/lib/paths";
import { parseRole } from "@/lib/roles";
import { createAgent } from "@kit/pack";
import { NextResponse } from "next/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ dir: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  const { dir } = await params;
  const packDir = resolvePackDir(decodeURIComponent(dir));
  if (!packDir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (!id || !description) {
    return NextResponse.json(
      { error: "id and description are required" },
      { status: 400 },
    );
  }

  try {
    await createAgent(packDir, {
      id,
      description,
      model: typeof body.model === "string" ? body.model : undefined,
      role: parseRole(body.role),
      instructions:
        typeof body.instructions === "string" ? body.instructions : undefined,
      tools: Array.isArray(body.tools)
        ? body.tools.filter((item): item is string => typeof item === "string")
        : [],
      skills: Array.isArray(body.skills)
        ? body.skills.filter((item): item is string => typeof item === "string")
        : [],
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "create failed" },
      { status: 400 },
    );
  }
}
