import { recordGateEvidenceSafely } from "@/lib/gate-evidence";
import { sameOriginError } from "@/lib/http";
import { resolvePackDir } from "@/lib/paths";
import { GATE_EVIDENCE_KIND } from "@kit/activity";
import {
  type StageEdge,
  type StagePosition,
  createWorkflow,
  deleteWorkflow,
  listWorkflows,
  renameWorkflow,
  setStageEdges,
  setStagePositions,
  writeWorkflowFile,
} from "@kit/pack";
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
  try {
    return NextResponse.json({ workflows: await listWorkflows(packDir) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "list failed" },
      { status: 400 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ dir: string }> },
) {
  if (sameOriginError(request)) {
    return NextResponse.json({ error: "invalid origin" }, { status: 403 });
  }
  const packDir = await packDirFrom(params);
  if (!packDir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }
  let body: { id?: unknown; file?: unknown; content?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.content === "string" && body.content.length > 256 * 1024) {
    return NextResponse.json(
      { error: "content exceeds 256KB" },
      { status: 400 },
    );
  }
  try {
    const workflow = await createWorkflow(packDir, {
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      ...(typeof body.file === "string" ? { file: body.file } : {}),
      ...(typeof body.content === "string" ? { content: body.content } : {}),
    });
    await recordGateEvidenceSafely({
      agentId: "operator",
      kind: GATE_EVIDENCE_KIND.workshopDagUpdated,
      status: "created",
      summary: `workflow ${workflow.id} created in the workshop editor`,
      payload: { packDir, workflow: workflow.id },
    });
    return NextResponse.json({ ok: true, workflow }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "create failed" },
      { status: 400 },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ dir: string }> },
) {
  if (sameOriginError(request)) {
    return NextResponse.json({ error: "invalid origin" }, { status: 403 });
  }
  const packDir = await packDirFrom(params);
  if (!packDir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }

  let body: {
    file?: unknown;
    content?: unknown;
    positions?: unknown;
    edges?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.file !== "string") {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (typeof body.content === "string" && body.content.length > 256 * 1024) {
    return NextResponse.json(
      { error: "content exceeds 256KB" },
      { status: 400 },
    );
  }

  try {
    if (typeof body.content === "string") {
      await writeWorkflowFile(packDir, body.file, body.content);
      await recordGateEvidenceSafely({
        agentId: "operator",
        kind: GATE_EVIDENCE_KIND.workshopDagUpdated,
        status: "updated",
        summary: `workflow ${body.file} saved in the workshop editor`,
        payload: { packDir, file: body.file },
      });
      return NextResponse.json({ ok: true });
    }
    if (Array.isArray(body.edges)) {
      const edges = parseEdges(body.edges);
      if (!edges) {
        return NextResponse.json({ error: "invalid edges" }, { status: 400 });
      }
      const content = await setStageEdges(packDir, body.file, edges);
      await recordGateEvidenceSafely({
        agentId: "operator",
        kind: GATE_EVIDENCE_KIND.workshopDagUpdated,
        status: "updated",
        summary: `workflow ${body.file} DAG edges updated (${edges.length})`,
        payload: { packDir, file: body.file, edges: edges.length },
      });
      return NextResponse.json({ ok: true, content });
    }
    const positions = parsePositions(body.positions);
    if (!positions) {
      return NextResponse.json(
        { error: "content, positions or edges are required" },
        { status: 400 },
      );
    }
    const content = await setStagePositions(packDir, body.file, positions);
    return NextResponse.json({ ok: true, content });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "save failed" },
      { status: 400 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ dir: string }> },
) {
  if (sameOriginError(request)) {
    return NextResponse.json({ error: "invalid origin" }, { status: 403 });
  }
  const packDir = await packDirFrom(params);
  if (!packDir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }
  let body: { file?: unknown; newFile?: unknown; newId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.file !== "string" || typeof body.newFile !== "string") {
    return NextResponse.json(
      { error: "file and newFile are required" },
      { status: 400 },
    );
  }
  try {
    const workflow = await renameWorkflow(packDir, {
      file: body.file,
      newFile: body.newFile,
      ...(typeof body.newId === "string" ? { newId: body.newId } : {}),
    });
    return NextResponse.json({ ok: true, workflow });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "rename failed" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ dir: string }> },
) {
  if (sameOriginError(request)) {
    return NextResponse.json({ error: "invalid origin" }, { status: 403 });
  }
  const packDir = await packDirFrom(params);
  if (!packDir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }
  let body: { file?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.file !== "string") {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  try {
    await deleteWorkflow(packDir, body.file);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "delete failed" },
      { status: 400 },
    );
  }
}

async function packDirFrom(params: Promise<{ dir: string }>) {
  const { dir } = await params;
  return resolvePackDir(decodeURIComponent(dir));
}

function parseEdges(value: unknown[]): StageEdge[] | null {
  if (value.length > 512) {
    return null;
  }
  const edges: StageEdge[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) {
      return null;
    }
    const { from, to } = raw as { from?: unknown; to?: unknown };
    if (typeof from !== "string" || typeof to !== "string") {
      return null;
    }
    edges.push({ from, to });
  }
  return edges;
}

function parsePositions(value: unknown): Record<string, StagePosition> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const positions: Record<string, StagePosition> = {};
  for (const [stageId, raw] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (typeof raw !== "object" || raw === null) {
      return null;
    }
    const { x, y } = raw as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number") {
      return null;
    }
    positions[stageId] = { x, y };
  }
  return Object.keys(positions).length > 0 ? positions : null;
}
