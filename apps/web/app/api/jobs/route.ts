import { readOnlyBlockMessage } from "@/lib/degradation";
import { sameOriginError } from "@/lib/http";
import { jobErrorResponse, liveGateError } from "@/lib/job-api";
import { getRepoRoot } from "@/lib/paths";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { runBudgetSpecSchema } from "@kit/core";
import { type JobKind, type MissionInput, listJobs, startJob } from "@kit/job";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const kind = parseKind(url.searchParams.get("kind"));
  const status = url.searchParams.get("status") || undefined;
  const limit = Number(url.searchParams.get("limit") ?? 20);
  try {
    await ensureStoreSchema();
    const jobs = await listJobs(getStore(), {
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    });
    return NextResponse.json({ jobs });
  } catch (error) {
    return jobErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const runMode = body.runMode === "LIVE" ? "LIVE" : "DRY_RUN";
  const gate = await liveGateError(runMode);
  if (gate) {
    return NextResponse.json({ error: gate }, { status: 403 });
  }
  const packDir = asString(body.packDir);
  if (!packDir) {
    return NextResponse.json({ error: "packDir is required" }, { status: 400 });
  }
  const budgetResult = runBudgetSpecSchema.optional().safeParse(body.budget);
  if (!budgetResult.success) {
    return NextResponse.json({ error: "invalid budget" }, { status: 400 });
  }
  const budget = budgetResult.data;

  try {
    await ensureStoreSchema();
    const blocked = await readOnlyBlockMessage();
    if (blocked) {
      return NextResponse.json({ error: blocked }, { status: 423 });
    }
    const result = await startJob(
      getStore(),
      {
        kind: parseKind(body.kind) ?? "packRun",
        packDir,
        projectId: asString(body.projectId),
        origin: "web",
        runMode,
        goal: asString(body.goal),
        acceptance: asString(body.acceptance),
        workflow: asString(body.workflow),
        domain: asString(body.domain),
        dedupeKey: asString(body.dedupeKey),
        evidenceText: asString(body.evidenceText),
        evidenceArtifactId: asString(body.evidenceArtifactId),
        applyMode: parseApplyMode(body.applyMode),
        maxTasks: asNumber(body.maxTasks),
        maxRepair: asNumber(body.maxRepair),
        budgetCny: asNumber(body.budgetCny),
        ...(budget ? { budget } : {}),
        coder: parseCoder(body.coder),
        stub: body.stub === true,
        mission: parseMission(body.mission),
      },
      { repoRoot: getRepoRoot() },
    );
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return jobErrorResponse(error);
  }
}

function parseKind(value: unknown): JobKind | undefined {
  return value === "iteration" || value === "packRun" ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseApplyMode(
  value: unknown,
): "none" | "low" | "low-medium" | undefined {
  return value === "none" || value === "low" || value === "low-medium"
    ? value
    : undefined;
}

function parseCoder(
  value: unknown,
): "dsh" | "codex" | "opencode" | "command" | undefined {
  return value === "dsh" ||
    value === "codex" ||
    value === "opencode" ||
    value === "command"
    ? value
    : undefined;
}

function parseMission(value: unknown): MissionInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const list = (input: unknown): string[] | undefined =>
    Array.isArray(input)
      ? input.filter((item): item is string => typeof item === "string")
      : undefined;
  return {
    manager: asString(record.manager),
    agents: list(record.agents),
    sellers: list(record.sellers),
    builders: list(record.builders),
    specialists: list(record.specialists),
  };
}
