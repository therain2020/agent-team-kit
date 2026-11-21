import path from "node:path";
import { sameOriginError } from "@/lib/http";
import { jobErrorResponse } from "@/lib/job-api";
import { getComponentsRoot, getPacksRoot, getRepoRoot } from "@/lib/paths";
import { loadPipelineInventory } from "@/lib/pipeline-inventory";
import { toSourceCandidateInputs } from "@/lib/source-draft";
import { searchSourceMarketForIntent } from "@/lib/sources";
import type { ComponentRef } from "@kit/core";
import {
  type AgentDraftValues,
  type ComposeKind,
  JobError,
  type PipelineDraftValues,
  type SourceCandidateInput,
  composeJob,
  parseWorkflowDraftStages,
} from "@kit/job";
import { AssemblyError, assembleComponents } from "@kit/pack";
import { workshopComponentLibrary } from "@kit/workshop";
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
          "kind must be mission, packRun, approvalPolicy, autopilot, evolutionCycle, agent, pack, workflow, pipeline, or source",
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
  const pipelineDir = kind === "pipeline" ? absolutePackDir(packDir) : null;
  if (kind === "pipeline" && !pipelineDir) {
    return NextResponse.json(
      { error: "packDir must be inside packs/" },
      { status: 400 },
    );
  }
  try {
    const sourceCandidates =
      kind === "source" ? await loadSourceCandidates(intent) : undefined;
    const pipeline = pipelineDir
      ? await loadPipelineInventory(pipelineDir)
      : undefined;
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
      ...(pipeline ? { pipeline } : {}),
    });
    // The pipeline draft is validated through the real assembler in dry-run
    // mode: the response carries the planned bindings but nothing is written.
    const assembly =
      pipelineDir && result.kind === "pipeline"
        ? await previewPipelineAssembly(
            pipelineDir,
            result.values as PipelineDraftValues,
          )
        : undefined;
    return NextResponse.json({ ...result, ...(assembly ? { assembly } : {}) });
  } catch (error) {
    return jobErrorResponse(error);
  }
}

interface AssemblyPreview {
  ok: boolean;
  preview?: boolean;
  bindings?: Array<{ node: string; component: ComponentRef }>;
  written?: string[];
  warnings?: string[];
  noop?: boolean;
  issues?: Array<{ code: string; path: string; message: string }>;
  error?: string;
}

async function previewPipelineAssembly(
  packDir: string,
  values: PipelineDraftValues,
): Promise<AssemblyPreview> {
  const components = values.components.map((component) => ({
    kind: component.ref.kind,
    id: component.ref.id,
  }));
  if (components.length === 0) {
    return { ok: true, preview: true, bindings: [], written: [], noop: true };
  }
  try {
    const result = await assembleComponents(
      { packDir, components, allowCommand: false, dryRun: true },
      workshopComponentLibrary(getComponentsRoot()),
    );
    return {
      ok: true,
      preview: true,
      bindings: result.bindings,
      written: result.written,
      warnings: result.warnings,
      noop: result.noop,
    };
  } catch (error) {
    if (error instanceof AssemblyError) {
      return {
        ok: false,
        preview: true,
        issues: error.issues,
        warnings: error.warnings,
      };
    }
    return {
      ok: false,
      preview: true,
      error: error instanceof Error ? error.message : "assembly preview failed",
    };
  }
}

/**
 * Resolve a pack id / path to its absolute directory, mirroring
 * `composeJob`'s containment check so the assembler preview and the lockfile
 * read use the same directory as the draft.
 */
function absolutePackDir(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const packsRoot = getPacksRoot();
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : trimmed.replace(/\\/g, "/").startsWith("packs/")
      ? path.resolve(getRepoRoot(), trimmed)
      : path.resolve(packsRoot, trimmed);
  const prefix = packsRoot.endsWith(path.sep)
    ? packsRoot
    : `${packsRoot}${path.sep}`;
  return resolved.startsWith(prefix) ? resolved : null;
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
    value === "pipeline" ||
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
