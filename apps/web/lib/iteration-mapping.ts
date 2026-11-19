import type {
  IterationEventView,
  IterationRunView,
  IterationTaskView,
  IterationTurnView,
} from "./iteration-types";

const STALE_MS = 3 * 60 * 1000;

export interface RunRow {
  iteration_id: string;
  workflow_id: string | null;
  repo_root: string | null;
  goal: string;
  acceptance: string | null;
  run_mode: string;
  apply_mode: string;
  status: string;
  phase: string;
  plan_artifact_id: string | null;
  report_artifact_id: string | null;
  error: string | null;
  last_heartbeat_at: Date | string | null;
  last_event_id: string | number | null;
  turn_count: number | null;
  tool_calls: number | null;
  started_at: Date | string;
  updated_at: Date | string;
  finished_at: Date | string | null;
}

export interface TaskRow {
  iteration_id: string;
  task_id: string;
  domain: string;
  goal: string;
  acceptance: string;
  status: string;
  phase: string;
  attempt: number;
  coder: string | null;
  risk: string | null;
  changed_files: string[] | string;
  tokens: number;
  coder_summary: string | null;
  apply_status: string | null;
  commit_sha: string | null;
  error: string | null;
  diff_artifact_id: string | null;
  transcript_artifact_id: string | null;
  verification_artifact_id: string | null;
  apply_artifact_id: string | null;
  last_heartbeat_at: Date | string | null;
  turn_count: number | null;
  tool_calls: number | null;
  started_at: Date | string;
  updated_at: Date | string;
  finished_at: Date | string | null;
}

export interface TurnRow {
  iteration_id: string;
  task_id: string;
  turn: number;
  status: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  steps: number;
  tool_calls: number;
  tokens: number;
  summary: string | null;
  error: string | null;
  last_event_id: string | number;
}

export interface EventRow {
  event_id: string | number;
  iteration_id: string;
  task_id: string | null;
  turn: number | null;
  step: number | null;
  kind: string;
  status: string | null;
  tool: string | null;
  summary: string | null;
  payload: Record<string, unknown> | string;
  created_at: Date | string;
}

export function mapRun(row: RunRow, tokens: number): IterationRunView {
  const lastHeartbeatAt = toIso(row.last_heartbeat_at);
  return {
    iterationId: row.iteration_id,
    workflowId: row.workflow_id,
    repoRoot: row.repo_root ?? null,
    goal: row.goal,
    acceptance: row.acceptance,
    runMode: row.run_mode,
    applyMode: row.apply_mode,
    status: row.status,
    phase: row.phase,
    tokens,
    turnCount: Number(row.turn_count ?? 0),
    toolCalls: Number(row.tool_calls ?? 0),
    lastHeartbeatAt,
    stalled: isStalled(row.status, lastHeartbeatAt),
    planArtifactId: row.plan_artifact_id,
    reportArtifactId: row.report_artifact_id,
    error: row.error,
    startedAt: toIso(row.started_at) ?? "",
    updatedAt: toIso(row.updated_at) ?? "",
    finishedAt: toIso(row.finished_at),
  };
}

export function mapTask(row: TaskRow): IterationTaskView {
  const lastHeartbeatAt = toIso(row.last_heartbeat_at);
  return {
    taskId: row.task_id,
    domain: row.domain,
    goal: row.goal,
    acceptance: row.acceptance,
    status: row.status,
    phase: row.phase,
    attempt: row.attempt,
    coder: row.coder,
    risk: row.risk,
    changedFiles: parseJson(row.changed_files, []),
    tokens: Number(row.tokens ?? 0),
    turnCount: Number(row.turn_count ?? 0),
    toolCalls: Number(row.tool_calls ?? 0),
    lastHeartbeatAt,
    stalled: isStalled(row.status, lastHeartbeatAt),
    coderSummary: row.coder_summary,
    applyStatus: row.apply_status,
    commit: row.commit_sha,
    error: row.error,
    diffArtifactId: row.diff_artifact_id,
    transcriptArtifactId: row.transcript_artifact_id,
    verificationArtifactId: row.verification_artifact_id,
    applyArtifactId: row.apply_artifact_id,
    startedAt: toIso(row.started_at) ?? "",
    updatedAt: toIso(row.updated_at) ?? "",
    finishedAt: toIso(row.finished_at),
  };
}

export function mapTurn(row: TurnRow): IterationTurnView {
  return {
    iterationId: row.iteration_id,
    taskId: row.task_id,
    turn: row.turn,
    status: row.status,
    startedAt: toIso(row.started_at) ?? "",
    finishedAt: toIso(row.finished_at),
    steps: row.steps,
    toolCalls: row.tool_calls,
    tokens: row.tokens,
    summary: row.summary,
    error: row.error,
    lastEventId: Number(row.last_event_id ?? 0),
  };
}

export function mapEvent(row: EventRow): IterationEventView {
  return {
    eventId: Number(row.event_id),
    iterationId: row.iteration_id,
    taskId: row.task_id,
    turn: row.turn,
    step: row.step,
    kind: row.kind,
    status: row.status,
    tool: row.tool,
    summary: row.summary,
    payload: parseJson(row.payload, {}),
    createdAt: toIso(row.created_at) ?? "",
  };
}

export function isStalled(
  status: string,
  lastHeartbeatAt: string | null,
): boolean {
  if (status !== "running") {
    return false;
  }
  if (!lastHeartbeatAt) {
    return true;
  }
  const last = new Date(lastHeartbeatAt).getTime();
  return Number.isFinite(last) ? Date.now() - last > STALE_MS : true;
}

export function toIso(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function parseJson<T>(value: T | string, fallback: T): T {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
