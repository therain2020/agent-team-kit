import { sameOriginError } from "@/lib/http";
import { resolvePackDir } from "@/lib/paths";
import { parseRole } from "@/lib/roles";
import { deleteAgent, updateAgent } from "@kit/pack";
import { NextResponse } from "next/server";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ dir: string; agentId: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  const { dir, agentId } = await params;
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

  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const instructions =
    typeof body.instructions === "string" ? body.instructions : "";
  if (!description || !model || instructions.trim().length === 0) {
    return NextResponse.json(
      { error: "description, model and instructions are required" },
      { status: 400 },
    );
  }
  if (instructions.length > 200_000) {
    return NextResponse.json(
      { error: "instructions exceed 200k characters" },
      { status: 400 },
    );
  }

  try {
    await updateAgent(packDir, decodeURIComponent(agentId), {
      description,
      model,
      role: parseRole(body.role),
      tools: stringArray(body.tools),
      skills: stringArray(body.skills),
      instructions,
      permissions: permissions(body.permissions),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "save failed" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ dir: string; agentId: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  const { dir, agentId } = await params;
  const packDir = resolvePackDir(decodeURIComponent(dir));
  if (!packDir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }
  try {
    await deleteAgent(packDir, decodeURIComponent(agentId));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "delete failed" },
      { status: 400 },
    );
  }
}

function stringArray(value: unknown, max = 30): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, max)
    : [];
}

function permissions(
  value: unknown,
): { filesystem?: string; network?: string } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const filesystem =
    typeof record.filesystem === "string" ? record.filesystem : undefined;
  const network =
    typeof record.network === "string" ? record.network : undefined;
  if (!filesystem && !network) {
    return undefined;
  }
  return { filesystem, network };
}
