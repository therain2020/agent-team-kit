import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveEvolutionEvidence } from "@/lib/evolution-evidence";
import { getEvolutionRepo } from "@/lib/evolution-repo";
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
    hypothesis?: unknown;
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
  let evidence: Awaited<ReturnType<typeof resolveEvolutionEvidence>>;
  try {
    evidence = await resolveEvolutionEvidence(body.evidenceText);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "invalid evidence" },
      { status: 400 },
    );
  }

  const repoRoot = getRepoRoot();
  const tempDir = path.join(repoRoot, ".tmp", "evolution");
  await mkdir(tempDir, { recursive: true });
  const inputFile = path.join(tempDir, `${newId("evc")}.json`);
  await writeFile(inputFile, evidence.text, "utf8");

  const variantsRoot = path.join(repoRoot, "variants");
  try {
    const record = await runEvolutionCycle({
      packDir,
      agentId: typeof body.agentId === "string" ? body.agentId : undefined,
      inputFile,
      hypothesis:
        typeof body.hypothesis === "string"
          ? body.hypothesis.trim().slice(0, 500)
          : undefined,
      stub: body.stub !== false,
      autoApply: body.autoApply === true,
      force: body.force !== false,
      archivePath: path.join(variantsRoot, "archive.jsonl"),
      cyclesPath: path.join(variantsRoot, "cycles.jsonl"),
      statePath: path.join(variantsRoot, "state.json"),
      variantsRoot,
      repo: await getEvolutionRepo(),
    });
    return NextResponse.json(
      {
        record,
        evidence: { generated: evidence.generated, sources: evidence.sources },
      },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "cycle failed" },
      { status: 500 },
    );
  } finally {
    await rm(inputFile, { force: true });
  }
}
