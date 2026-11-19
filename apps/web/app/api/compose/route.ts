import { sameOriginError } from "@/lib/http";
import { jobErrorResponse } from "@/lib/job-api";
import { getRepoRoot } from "@/lib/paths";
import { toSourceCandidateInputs } from "@/lib/source-draft";
import { searchSourceMarketForIntent } from "@/lib/sources";
import {
  type AgentDraftValues,
  type ComposeKind,
  JobError,
  type SourceCandidateInput,
  composeJob,
  parseWorkflowDraftStages,
} from "@kit/job";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    kind?: unknown;
    intent?: unknown;
    packDir?: unknown;
    agentId?: unknown;
    current?: unknown;
    templateId?: unknown;
    currentStages?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const kind = parseKind(body.kind);
  if (!kind) {
    return NextResponse.json(
      {
        error:
          "kind must be mission, packRun, approvalPolicy, autopilot, evolutionCycle, agent, pack, workflow, or source",
      },
      { status: 400 },
    );
  }
  // `pack` and `source` drafts scaffold something brand new, so they have no
  // existing pack directory to resolve against.
  const intent = typeof body.intent === "string" ? body.intent : "";
  const packDir = typeof body.packDir === "string" ? body.packDir : "";
  if (kind !== "pack" && kind !== "source" && !packDir.trim()) {
    return NextResponse.json({ error: "packDir is required" }, { status: 400 });
  }
  if (kind === "source" && !intent.trim()) {
    return NextResponse.json({ error: "intent is required" }, { status: 400 });
  }

  const current = parseAgentCurrent(body.current);
  const currentStages = parseWorkflowDraftStages(body.currentStages);
  try {
    const sourceCandidates =
      kind === "source" ? await loadSourceCandidates(intent) : undefined;
    const result = await composeJob({
      kind,
      intent,
      packDir,
      repoRoot: getRepoRoot(),
      ...(typeof body.agentId === "string" ? { agentId: body.agentId } : {}),
      ...(typeof body.templateId === "string"
        ? { templateId: body.templateId }
        : {}),
      ...(current ? { current } : {}),
      ...(currentStages ? { currentStages } : {}),
      ...(sourceCandidates ? { sourceCandidates } : {}),
    });
    return NextResponse.json(result);
  } catch (error) {
    return jobErrorResponse(error);
  }
}

async function loadSourceCandidates(
  intent: string,
): Promise<SourceCandidateInput[]> {
  try {
    return toSourceCandidateInputs(await searchSourceMarketForIntent(intent));
  } catch (error) {
    throw new JobError(
      "source_search_failed",
      error instanceof Error ? error.message : "source market search failed",
      502,
    );
  }
}

function parseKind(value: unknown): ComposeKind | undefined {
  return value === "mission" ||
    value === "packRun" ||
    value === "approvalPolicy" ||
    value === "autopilot" ||
    value === "evolutionCycle" ||
    value === "agent" ||
    value === "pack" ||
    value === "workflow" ||
    value === "source"
    ? value
    : undefined;
}

function parseAgentCurrent(
  value: unknown,
): Partial<AgentDraftValues> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const current: Partial<AgentDraftValues> = {};
  if (typeof record.description === "string") {
    current.description = record.description;
  }
  if (typeof record.model === "string") {
    current.model = record.model;
  }
  if (typeof record.role === "string") {
    current.role = record.role as AgentDraftValues["role"];
  }
  if (typeof record.instructions === "string") {
    current.instructions = record.instructions;
  }
  if (Array.isArray(record.tools)) {
    current.tools = record.tools.filter(
      (item): item is string => typeof item === "string",
    );
  }
  if (Array.isArray(record.skills)) {
    current.skills = record.skills.filter(
      (item): item is string => typeof item === "string",
    );
  }
  return Object.keys(current).length > 0 ? current : undefined;
}
