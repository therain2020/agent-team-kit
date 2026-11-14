import { sameOriginError } from "@/lib/http";
import { resolvePackDir } from "@/lib/paths";
import { loadPack, setStageApproval } from "@kit/pack";
import { NextResponse } from "next/server";

type StageApproval = Parameters<typeof setStageApproval>[3];
type LoadResult = Awaited<ReturnType<typeof loadPack>>;

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
    approvals?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (Array.isArray(body.approvals)) {
    return applyBatch(packDir, body.approvals);
  }

  if (typeof body.file !== "string" || typeof body.stageId !== "string") {
    return NextResponse.json(
      { error: "file and stageId are required" },
      { status: 400 },
    );
  }

  try {
    await setStageApproval(
      packDir,
      body.file,
      body.stageId,
      toApproval(body.approval),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "save failed" },
      { status: 400 },
    );
  }
}

async function applyBatch(
  packDir: string,
  raw: unknown[],
): Promise<NextResponse> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    return NextResponse.json(
      { error: "invalid pack", details: loaded.errors },
      { status: 400 },
    );
  }
  const entries: Array<{
    file: string;
    stageId: string;
    approval: StageApproval;
  }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return NextResponse.json(
        { error: "approvals entries must be objects" },
        { status: 400 },
      );
    }
    const record = item as Record<string, unknown>;
    if (typeof record.file !== "string" || typeof record.stageId !== "string") {
      return NextResponse.json(
        { error: "each approval needs file and stageId" },
        { status: 400 },
      );
    }
    const stageError = validateStage(loaded, record.file, record.stageId);
    if (stageError) {
      return NextResponse.json({ error: stageError }, { status: 400 });
    }
    entries.push({
      file: record.file,
      stageId: record.stageId,
      approval: toApproval(record.approval),
    });
  }

  try {
    for (const entry of entries) {
      await setStageApproval(
        packDir,
        entry.file,
        entry.stageId,
        entry.approval,
      );
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "save failed" },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true, applied: entries.length });
}

function validateStage(
  loaded: LoadResult,
  file: string,
  stageId: string,
): string | null {
  if (!loaded.ok) {
    return "invalid pack";
  }
  const index = loaded.pack.workflows.indexOf(file);
  if (index < 0) {
    return `unknown workflow file: ${file}`;
  }
  const workflow = loaded.workflows[index];
  if (!workflow?.stages.some((stage) => stage.id === stageId)) {
    return `unknown stage: ${file} ${stageId}`;
  }
  return null;
}

function toApproval(value: unknown): StageApproval {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const approval = value as Record<string, unknown>;
  return {
    mode: approval.mode,
    position: approval.position,
    riskClass: approval.riskClass,
    ttl: approval.ttl,
    autoApproveWhen: approval.autoApproveWhen,
  } as StageApproval;
}
