import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sameOriginError } from "@/lib/http";
import { getRepoRoot, resolvePackDir } from "@/lib/paths";
import { newId } from "@kit/core";
import { runEvolutionCycle } from "@kit/evolution";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    packDir?: unknown;
    agentId?: unknown;
    evidenceText?: unknown;
    stub?: unknown;
    autoApply?: unknown;
    force?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (typeof body.packDir !== "string") {
    return NextResponse.json({ error: "packDir is required" }, { status: 400 });
  }
  const packDir = resolvePackDir(body.packDir.replace(/^packs[\\/]/, ""));
  if (!packDir) {
    return NextResponse.json({ error: "invalid packDir" }, { status: 400 });
  }
  const evidenceText =
    typeof body.evidenceText === "string" ? body.evidenceText.trim() : "";
  if (!evidenceText) {
    return NextResponse.json(
      { error: "evidenceText is required for evaluation" },
      { status: 400 },
    );
  }
  if (evidenceText.length > 200_000) {
    return NextResponse.json(
      { error: "evidenceText exceeds 200k characters" },
      { status: 400 },
    );
  }

  const repoRoot = getRepoRoot();
  const tempDir = path.join(repoRoot, ".tmp", "evolution");
  await mkdir(tempDir, { recursive: true });
  const inputFile = path.join(tempDir, `${newId("evc")}.json`);
  await writeFile(inputFile, evidenceText, "utf8");

  const variantsRoot = path.join(repoRoot, "variants");
  try {
    const record = await runEvolutionCycle({
      packDir,
      agentId: typeof body.agentId === "string" ? body.agentId : undefined,
      inputFile,
      stub: body.stub !== false,
      autoApply: body.autoApply === true,
      force: body.force !== false,
      archivePath: path.join(variantsRoot, "archive.jsonl"),
      cyclesPath: path.join(variantsRoot, "cycles.jsonl"),
      statePath: path.join(variantsRoot, "state.json"),
      variantsRoot,
    });
    return NextResponse.json({ record }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "cycle failed" },
      { status: 500 },
    );
  }
}
