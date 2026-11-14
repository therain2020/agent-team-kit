import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEvolutionRepo } from "@/lib/evolution-repo";
import { sameOriginError } from "@/lib/http";
import { getRepoRoot } from "@/lib/paths";
import { newId } from "@kit/core";
import { evaluateCanary } from "@kit/evolution";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: { evidenceText?: unknown; stub?: unknown; incident?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (
    typeof body.evidenceText !== "string" ||
    body.evidenceText.length === 0 ||
    body.evidenceText.length > 200_000
  ) {
    return NextResponse.json(
      {
        error: "evidenceText must be a non-empty string under 200k characters",
      },
      { status: 400 },
    );
  }
  try {
    const parsed = JSON.parse(body.evidenceText) as { sources?: unknown };
    if (!Array.isArray(parsed.sources)) {
      return NextResponse.json(
        { error: "evidence must contain a sources[] array" },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: "evidenceText must be valid JSON" },
      { status: 400 },
    );
  }

  const repoRoot = getRepoRoot();
  const tmpDir = path.join(repoRoot, ".tmp", "canary-ui");
  const evidencePath = path.join(tmpDir, `${newId("evi")}.json`);
  const archivePath = path.join(repoRoot, "variants", "archive.jsonl");
  const statePath = path.join(repoRoot, "variants", "state.json");

  await mkdir(tmpDir, { recursive: true });
  await writeFile(evidencePath, body.evidenceText, "utf8");

  try {
    const result = await evaluateCanary([evidencePath], {
      stub: body.stub !== false,
      archive: archivePath,
      statePath,
      repo: await getEvolutionRepo(),
      ...(typeof body.incident === "string" && body.incident.trim()
        ? { incident: body.incident.slice(0, 500) }
        : {}),
    });
    return NextResponse.json({
      ok: true,
      decision: result.decision,
      champion: result.champion,
      variant: result.variant,
      state: result.state,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "canary evaluation failed",
      },
      { status: 409 },
    );
  } finally {
    await rm(evidencePath, { force: true });
  }
}
