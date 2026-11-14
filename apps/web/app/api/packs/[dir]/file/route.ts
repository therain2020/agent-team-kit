import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { sameOriginError } from "@/lib/http";
import { resolvePackDir } from "@/lib/paths";
import {
  listEditablePackFiles,
  resolvePackRelative,
  writeValidatedPackFile,
} from "@kit/pack";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ dir: string }> },
) {
  const { dir } = await params;
  const packDir = resolvePackDir(decodeURIComponent(dir));
  if (!packDir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }

  const relative = new URL(request.url).searchParams.get("path");
  try {
    if (!relative) {
      return NextResponse.json({ files: await listEditablePackFiles(packDir) });
    }
    const file = resolvePackRelative(packDir, relative);
    if (!file) {
      return NextResponse.json(
        { error: "file is not editable" },
        { status: 400 },
      );
    }
    const exists = existsSync(file);
    const content = exists ? await readFile(file, "utf8") : "";
    return NextResponse.json({ path: relative, exists, content });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "read failed" },
      { status: 400 },
    );
  }
}

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

  let body: { path?: unknown; content?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.path !== "string" || typeof body.content !== "string") {
    return NextResponse.json(
      { error: "path and content are required" },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(body.content, "utf8") > 256 * 1024) {
    return NextResponse.json(
      { error: "content exceeds 256KB" },
      { status: 400 },
    );
  }

  try {
    await writeValidatedPackFile(packDir, body.path, body.content);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "save failed" },
      { status: 400 },
    );
  }
}
