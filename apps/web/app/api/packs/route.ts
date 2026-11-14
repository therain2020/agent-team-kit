import { sameOriginError } from "@/lib/http";
import { getPacksRoot } from "@/lib/paths";
import { parseRole } from "@/lib/roles";
import { type PackTemplate, createPack } from "@kit/pack";
import { NextResponse } from "next/server";

const TEMPLATES: PackTemplate[] = ["minimal", "research", "content", "product"];

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    dirName?: unknown;
    name?: unknown;
    description?: unknown;
    template?: unknown;
    managerName?: unknown;
    managerModel?: unknown;
    managerInstructions?: unknown;
    agents?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (typeof body.dirName !== "string" || typeof body.name !== "string") {
    return NextResponse.json(
      { error: "dirName and name are required" },
      { status: 400 },
    );
  }
  const template = body.template as PackTemplate;
  if (!TEMPLATES.includes(template)) {
    return NextResponse.json(
      { error: `template must be one of ${TEMPLATES.join(", ")}` },
      { status: 400 },
    );
  }

  const agents = Array.isArray(body.agents)
    ? body.agents.slice(0, 12).flatMap((agent) => {
        if (typeof agent !== "object" || agent === null) {
          return [];
        }
        const value = agent as Record<string, unknown>;
        if (
          typeof value.id !== "string" ||
          typeof value.description !== "string"
        ) {
          return [];
        }
        return [
          {
            id: value.id,
            description: value.description,
            model: typeof value.model === "string" ? value.model : undefined,
            role: parseRole(value.role),
            instructions:
              typeof value.instructions === "string"
                ? value.instructions
                : undefined,
          },
        ];
      })
    : undefined;

  try {
    const result = await createPack({
      root: getPacksRoot(),
      dirName: body.dirName,
      name: body.name,
      description:
        typeof body.description === "string" ? body.description : undefined,
      template,
      managerName:
        typeof body.managerName === "string" ? body.managerName : undefined,
      managerModel:
        typeof body.managerModel === "string" ? body.managerModel : undefined,
      managerInstructions:
        typeof body.managerInstructions === "string"
          ? body.managerInstructions
          : undefined,
      agents,
    });
    return NextResponse.json(
      { ok: true, dirName: result.dirName },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "create failed";
    return NextResponse.json(
      { error: message },
      { status: message.includes("already exists") ? 409 : 400 },
    );
  }
}
