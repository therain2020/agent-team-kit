import { sameOriginError } from "@/lib/http";
import { resolvePackDir } from "@/lib/paths";
import { setStageApproval } from "@kit/pack";
import { NextResponse } from "next/server";

export async function PUT(
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

  let body: {
    file?: unknown;
    stageId?: unknown;
    approval?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.file !== "string" || typeof body.stageId !== "string") {
    return NextResponse.json(
      { error: "file and stageId are required" },
      { status: 400 },
    );
  }

  try {
    const approval =
      body.approval === null
        ? null
        : typeof body.approval === "object" && body.approval !== null
          ? (body.approval as Record<string, unknown>)
          : null;
    await setStageApproval(
      packDir,
      body.file,
      body.stageId,
      approval
        ? ({
            mode: approval.mode,
            position: approval.position,
            riskClass: approval.riskClass,
            ttl: approval.ttl,
            autoApproveWhen: approval.autoApproveWhen,
          } as Parameters<typeof setStageApproval>[3])
        : null,
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "save failed" },
      { status: 400 },
    );
  }
}
