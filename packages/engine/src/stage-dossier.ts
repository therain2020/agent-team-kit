import { redactPayload } from "@kit/activity";
import { redactText } from "@kit/ops";
import type { initStore } from "@kit/store";
import type { PackStageExecutionInput } from "@kit/workflow";

type Store = Awaited<ReturnType<typeof initStore>>;

/**
 * Stage dossier (30 §3.3): every stage keeps the resolved prompt and a compact
 * transcript as artifacts so the glass-box UI can answer "what did this stage
 * do, with what prompt, and what came out". Both artifacts are written
 * best-effort — observability must never fail a run.
 */
export const STAGE_INSTRUCTIONS_SUFFIX = ":instructions";
export const STAGE_TRANSCRIPT_SUFFIX = ":transcript";

export const STAGE_INSTRUCTIONS_MAX_CHARS = 4096;
export const TRANSCRIPT_REQUEST_MAX_CHARS = 300;
export const TRANSCRIPT_RESPONSE_MAX_CHARS = 1000;
export const TRANSCRIPT_FINAL_MAX_CHARS = 4096;
export const TRANSCRIPT_ARGS_MAX_CHARS = 500;
export const TRANSCRIPT_RESULT_MAX_CHARS = 500;

export interface StageInstructionsContent {
  kind: "stage.instructions";
  runId: string;
  stageId: string;
  stageName: string;
  type: string;
  agentId: string | null;
  modelId: string;
  promptHash: string;
  workflowId: string | null;
  workflowVersion: string | null;
  runMode: string;
  instructions: string;
  truncated: boolean;
}

export interface TranscriptToolCall {
  index: number;
  tool: string;
  argsSummary: string;
  resultSummary: string;
  isError: boolean;
  durationMs?: number;
}

export interface TranscriptTurn {
  index: number;
  kind: "model" | "coder" | "workflow";
  requestSummary: string;
  responseSummary: string;
  toolCalls: TranscriptToolCall[];
}

export interface StageTranscriptContent {
  kind: "stage.transcript";
  runId: string;
  stageId: string;
  stageName: string;
  type: string;
  agentId: string | null;
  modelId: string;
  workflowId: string | null;
  workflowVersion: string | null;
  runMode: string;
  startedAt: string | null;
  finishedAt: string;
  durationMs: number;
  instructionsArtifactId: string | null;
  inputs: Array<{ artifactId: string; version: number }>;
  outputArtifactId: string | null;
  gateScore: number | null;
  toolCalls: number;
  truncated: boolean;
  turns: TranscriptTurn[];
  finalResponse: string;
}

export interface TranscriptPublishContext {
  instructionsArtifactId: string | null;
  outputArtifactId: string | null;
  inputs: Array<{ artifactId: string; version: number }>;
  gateScore: number | null;
  turns: TranscriptTurn[];
  finalResponse: string;
  promptHash: string;
  modelId: string;
  workflowId: string | null;
  workflowVersion: string | null;
  startedAt: string | null;
}

export function stageInstructionsStageId(stageId: string): string {
  return `${stageId}${STAGE_INSTRUCTIONS_SUFFIX}`;
}

export function stageTranscriptStageId(stageId: string): string {
  return `${stageId}${STAGE_TRANSCRIPT_SUFFIX}`;
}

/**
 * Redacts credentials, then bounds the text. `truncated` is surfaced in the
 * artifact content so the viewer can warn instead of silently dropping data.
 */
export function redactAndClip(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  const redacted = redactText(text);
  if (redacted.length <= max) {
    return { text: redacted, truncated: false };
  }
  return { text: `${redacted.slice(0, max)}…[truncated]`, truncated: true };
}

export function summarizeRequest(text: string): {
  text: string;
  truncated: boolean;
} {
  return redactAndClip(text, TRANSCRIPT_REQUEST_MAX_CHARS);
}

export function summarizeResponse(text: string): {
  text: string;
  truncated: boolean;
} {
  return redactAndClip(text, TRANSCRIPT_RESPONSE_MAX_CHARS);
}

export function summarizeToolArgs(args: Record<string, unknown>): {
  text: string;
  truncated: boolean;
} {
  let serialized: string;
  try {
    serialized = JSON.stringify(redactPayload(args));
  } catch {
    serialized = String(args);
  }
  return redactAndClip(serialized, TRANSCRIPT_ARGS_MAX_CHARS);
}

export function summarizeToolResult(content: string): {
  text: string;
  truncated: boolean;
} {
  return redactAndClip(content, TRANSCRIPT_RESULT_MAX_CHARS);
}

export function buildInstructionsContent(
  input: PackStageExecutionInput,
  metadata: {
    promptHash: string;
    modelId: string;
    workflowId: string | null;
    workflowVersion: string | null;
  },
): StageInstructionsContent {
  const instructions = input.instructions ?? input.stageName;
  const clipped = redactAndClip(instructions, STAGE_INSTRUCTIONS_MAX_CHARS);
  return {
    kind: "stage.instructions",
    runId: input.runId,
    stageId: input.stageId,
    stageName: input.stageName,
    type: input.type,
    agentId: input.agentId ?? null,
    modelId: metadata.modelId,
    promptHash: metadata.promptHash,
    workflowId: metadata.workflowId,
    workflowVersion: metadata.workflowVersion,
    runMode: input.runMode,
    instructions: clipped.text,
    truncated: clipped.truncated,
  };
}

export function buildTranscriptContent(
  input: PackStageExecutionInput,
  context: TranscriptPublishContext,
): StageTranscriptContent {
  const final = redactAndClip(
    context.finalResponse,
    TRANSCRIPT_FINAL_MAX_CHARS,
  );
  const toolCalls = context.turns.reduce(
    (sum, turn) => sum + turn.toolCalls.length,
    0,
  );
  return {
    kind: "stage.transcript",
    runId: input.runId,
    stageId: input.stageId,
    stageName: input.stageName,
    type: input.type,
    agentId: input.agentId ?? null,
    modelId: context.modelId,
    workflowId: context.workflowId,
    workflowVersion: context.workflowVersion,
    runMode: input.runMode,
    startedAt: context.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: context.startedAt
      ? Math.max(0, Date.now() - Date.parse(context.startedAt))
      : 0,
    instructionsArtifactId: context.instructionsArtifactId,
    inputs: context.inputs,
    outputArtifactId: context.outputArtifactId,
    gateScore: context.gateScore,
    toolCalls,
    truncated: final.truncated,
    turns: context.turns,
    finalResponse: final.text,
  };
}

/**
 * Publishes the resolved prompt as `stage.instructions`. Returns the artifact id
 * or null; a failed write is logged and never fails the run.
 */
export async function publishStageInstructions(
  store: Store,
  input: PackStageExecutionInput,
  metadata: {
    promptHash: string;
    modelId: string;
    workflowId: string | null;
    workflowVersion: string | null;
  },
): Promise<string | null> {
  const stageId = stageInstructionsStageId(input.stageId);
  try {
    const existing = await store.artifactStore.findCommittedByRunStage(
      input.runId,
      stageId,
    );
    if (existing) {
      return existing.artifactId;
    }

    const content = buildInstructionsContent(input, metadata);
    const published = await store.artifactService.publish({
      workspaceId: input.workspaceId,
      content: new TextEncoder().encode(JSON.stringify(content, null, 2)),
      producer: {
        agentId: input.agentId ?? "workflow",
        agentVersion: "1.0.0",
        promptHash: metadata.promptHash,
        modelId: metadata.modelId,
      },
      inputs: [],
      runId: input.runId,
      stageId,
      runMode: input.runMode,
      cost: { currency: "CNY", amount: 0, tokens: 0 },
      sensitivity: "internal",
      retentionClass: "artifact_365d",
    });
    return published.artifact.artifactId;
  } catch (error) {
    console.error(
      `[stage-dossier] instructions write failed: ${errorMessage(error)}`,
    );
    return null;
  }
}

/**
 * Publishes the stage transcript. Manifest inputs are the stage's input
 * artifacts, so `artifact_edges` gets `consumed` edges for free.
 */
export async function publishStageTranscript(
  store: Store,
  input: PackStageExecutionInput,
  context: TranscriptPublishContext,
): Promise<string | null> {
  const stageId = stageTranscriptStageId(input.stageId);
  try {
    const existing = await store.artifactStore.findCommittedByRunStage(
      input.runId,
      stageId,
    );
    if (existing) {
      return existing.artifactId;
    }

    const content = buildTranscriptContent(input, context);
    const published = await store.artifactService.publish({
      workspaceId: input.workspaceId,
      content: new TextEncoder().encode(JSON.stringify(content, null, 2)),
      producer: {
        agentId: input.agentId ?? "workflow",
        agentVersion: "1.0.0",
        promptHash: context.promptHash,
        modelId: context.modelId,
      },
      inputs: context.inputs,
      runId: input.runId,
      stageId,
      runMode: input.runMode,
      cost: { currency: "CNY", amount: 0, tokens: 0 },
      sensitivity: "internal",
      retentionClass: "artifact_365d",
    });
    return published.artifact.artifactId;
  } catch (error) {
    console.error(
      `[stage-dossier] transcript write failed: ${errorMessage(error)}`,
    );
    return null;
  }
}

/**
 * Weighted mean of the gate dimensions, mirroring the rubric weights. Returns
 * null when the gate produced no scores (for example the deterministic stub).
 */
export function computeGateScore(
  scores: Record<string, number>,
  weights: Record<string, number>,
): number | null {
  let weighted = 0;
  let total = 0;
  for (const [dimension, score] of Object.entries(scores)) {
    if (!Number.isFinite(score)) {
      continue;
    }
    const weight = Number.isFinite(weights[dimension])
      ? Math.max(0, weights[dimension] ?? 0)
      : 1;
    weighted += score * weight;
    total += weight;
  }
  if (total <= 0) {
    return null;
  }
  return Math.round((weighted / total) * 1000) / 1000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
