import { sameOriginError } from "@/lib/http";
import { resolvePackDir } from "@/lib/paths";
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflows,
  renameWorkflow,
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

  let body: { file?: unknown; content?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.file !== "string" || typeof body.content !== "string") {
    return NextResponse.json(
      { error: "file and content are required" },
      { status: 400 },
    );
  }
  if (body.content.length > 256 * 1024) {
    return NextResponse.json(
      { error: "content exceeds 256KB" },
      { status: 400 },
    );
  }

  try {
    await writeWorkflowFile(packDir, body.file, body.content);
    return NextResponse.json({ ok: true });
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
