import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveEvolutionEvidence } from "@/lib/evolution-evidence";
import { getEvolutionRepo } from "@/lib/evolution-repo";
import { sameOriginError } from "@/lib/http";
import { getRepoRoot } from "@/lib/paths";
import { newId } from "@kit/core";
import {
  canaryStatus,
  createEvalSnapshot,
  defaultCyclesRoot,
  evaluateCanary,
} from "@kit/evolution";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: { evidenceText?: unknown; incident?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
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

  const repo = await getEvolutionRepo();
  const state = await canaryStatus({ repo });
  if (
    !state?.canary ||
    (state.canary.status !== "shadow" && state.canary.status !== "canary")
  ) {
    return NextResponse.json({ error: "no active canary" }, { status: 409 });
  }

  const repoRoot = getRepoRoot();
  const tmpDir = path.join(repoRoot, ".tmp", "canary-ui");
  const evidencePath = path.join(tmpDir, `${newId("evi")}.json`);
  const archivePath = path.join(repoRoot, "variants", "archive.jsonl");
  const statePath = path.join(repoRoot, "variants", "state.json");

  await mkdir(tmpDir, { recursive: true });
  await writeFile(evidencePath, evidence.text, "utf8");

  try {
    const evalDir =
      state.canary.evalSnapshotPath ??
      (
        await createEvalSnapshot({
          cycleId: newId("evl"),
          packDir: state.champion.path,
          cyclesRoot: defaultCyclesRoot(),
        })
      ).dir;

    const result = await evaluateCanary([evidencePath], {
      archive: archivePath,
      statePath,
      repo,
      evalDir,
      actor: "console",
      ...(typeof body.incident === "string" && body.incident.trim()
        ? { incident: body.incident.trim().slice(0, 500) }
        : {}),
    });
    return NextResponse.json({
      ok: true,
      evidence: { generated: evidence.generated, sources: evidence.sources },
      evaluation: result.summary,
      decision: result.decision,
      evalSnapshotPath: result.state.canary?.evalSnapshotPath ?? evalDir,
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
