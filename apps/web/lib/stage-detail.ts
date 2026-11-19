/**
 * Stage detail drawer payload (89 §3.2, 30 §3.3, issue #156).
 *
 * Pure parsing lives here so the drawer, the API route and the unit tests
 * share one shape. The server loader is `stage-detail-server.ts`; nothing in
 * this module touches the store or the filesystem.
 */

/** ① What the stage does — from the pack's workflow definition. */
export interface StageDefinitionView {
  id: string;
  type: string;
  agent: string | null;
  coder: string | null;
  goal: string | null;
  acceptance: string | null;
  timeout: string | null;
  gate: string | null;
}

export interface StageAgentView {
  id: string;
  role: string;
  description: string;
}

/** ② Prompt actually sent to the model (`stage.instructions`, 30.4). */
export interface StagePromptView {
  artifactId: string | null;
  text: string;
  /** The dossier clipped the prompt at write time. */
  truncated: boolean;
  available: boolean;
}

export interface StageToolCallView {
  index: number;
  tool: string;
  argsSummary: string;
  resultSummary: string;
  isError: boolean;
}

export interface StageTurnView {
  index: number;
  kind: string;
  requestSummary: string;
  responseSummary: string;
  toolCalls: StageToolCallView[];
}

/** ③ Execution result (`stage.transcript` + gate evidence, 30.4). */
export interface StageTranscriptView {
  artifactId: string | null;
  available: boolean;
  finalResponse: string;
  turns: StageTurnView[];
  toolCallCount: number;
  gateScore: number | null;
  durationMs: number | null;
  truncated: boolean;
  inputs: Array<{ artifactId: string; version: number }>;
  outputArtifactId: string | null;
}

export interface StageGateView {
  attempt: number;
  pass: boolean;
  scores: Record<string, number>;
  thresholds: Record<string, number>;
  summary: string;
}

export interface StageArtifactView {
  artifactId: string;
  version: number;
  kind: string;
  stageId: string;
  createdAt: string;
}

export interface StageDetailData {
  found: boolean;
  runId: string;
  stageId: string | null;
  stageName: string | null;
  runStatus: string | null;
  stageStatus: string | null;
  definition: StageDefinitionView | null;
  agent: StageAgentView | null;
  prompt: StagePromptView | null;
  transcript: StageTranscriptView | null;
  gates: StageGateView[];
  artifacts: StageArtifactView[];
  approval: { requestId: string; summary: string } | null;
}

/** Turns and tool calls are capped so one busy stage cannot freeze the drawer. */
export const MAX_TURNS = 12;
export const MAX_TOOL_CALLS = 40;
export const MAX_TEXT = 4_000;

/**
 * `run_1:build` → `build`. Runtime stage ids are `${runId}:${stageName}`, and
 * the workflow definition uses the bare stage name.
 */
export function stageNameFromId(
  runId: string,
  stageId: string | null | undefined,
): string | null {
  if (!stageId) {
    return null;
  }
  const prefix = `${runId}:`;
  if (stageId.startsWith(prefix)) {
    return stageId.slice(prefix.length);
  }
  const parts = stageId.split(":");
  return parts[parts.length - 1] ?? stageId;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clip(
  text: string,
  max = MAX_TEXT,
): { text: string; clipped: boolean } {
  if (text.length <= max) {
    return { text, clipped: false };
  }
  return { text: text.slice(0, max), clipped: true };
}

/** Parses the `stage.instructions` artifact blob. */
export function parseInstructions(
  raw: string,
  artifactId: string | null,
): StagePromptView {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(raw));
  } catch {
    // A non-JSON blob is still the prompt; show it verbatim.
  }
  const text = parsed ? asString(parsed.instructions) : raw;
  if (!text) {
    return { artifactId, text: "", truncated: false, available: false };
  }
  const clipped = clip(text);
  return {
    artifactId,
    text: clipped.text,
    truncated: clipped.clipped || parsed?.truncated === true,
    available: true,
  };
}

/**
 * Parses the `stage.transcript` artifact blob. Unknown or malformed payloads
 * degrade to an empty transcript marked `available: false`, never throw.
 */
export function parseTranscript(
  raw: string,
  artifactId: string | null,
): StageTranscriptView {
  const empty: StageTranscriptView = {
    artifactId,
    available: false,
    finalResponse: "",
    turns: [],
    toolCallCount: 0,
    gateScore: null,
    durationMs: null,
    truncated: false,
    inputs: [],
    outputArtifactId: null,
  };
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(raw));
  } catch {
    return empty;
  }
  if (!parsed) {
    return empty;
  }

  const rawTurns = Array.isArray(parsed.turns) ? parsed.turns : [];
  const turns: StageTurnView[] = [];
  let toolCalls = 0;
  let dropped = false;

  for (const entry of rawTurns) {
    const turn = asRecord(entry);
    if (!turn) {
      continue;
    }
    const calls: StageToolCallView[] = [];
    const rawCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
    for (const callEntry of rawCalls) {
      const call = asRecord(callEntry);
      if (!call || typeof call.tool !== "string") {
        continue;
      }
      if (toolCalls >= MAX_TOOL_CALLS) {
        dropped = true;
        break;
      }
      toolCalls += 1;
      calls.push({
        index: toolCalls,
        tool: call.tool,
        argsSummary: asString(call.argsSummary) ?? "",
        resultSummary: asString(call.resultSummary) ?? "",
        isError: call.isError === true,
      });
    }
    if (turns.length >= MAX_TURNS) {
      dropped = true;
      continue;
    }
    turns.push({
      index: asNumber(turn.index) ?? turns.length + 1,
      kind: asString(turn.kind) ?? "model",
      requestSummary: asString(turn.requestSummary) ?? "",
      responseSummary: asString(turn.responseSummary) ?? "",
      toolCalls: calls,
    });
  }

  const inputs: Array<{ artifactId: string; version: number }> = [];
  if (Array.isArray(parsed.inputs)) {
    for (const entry of parsed.inputs) {
      const ref = asRecord(entry);
      const artifactId = ref ? asString(ref.artifactId) : null;
      if (!artifactId) {
        continue;
      }
      inputs.push({
        artifactId,
        version: asNumber(ref?.version) ?? 1,
      });
    }
  }

  const finalResponse = clip(asString(parsed.finalResponse) ?? "");
  return {
    artifactId,
    available: true,
    finalResponse: finalResponse.text,
    turns,
    toolCallCount:
      asNumber(parsed.toolCalls) !== null
        ? Math.max(asNumber(parsed.toolCalls) ?? 0, toolCalls)
        : toolCalls,
    gateScore: asNumber(parsed.gateScore),
    durationMs: asNumber(parsed.durationMs),
    truncated: dropped || finalResponse.clipped || parsed.truncated === true,
    inputs,
    outputArtifactId: asString(parsed.outputArtifactId),
  };
}
