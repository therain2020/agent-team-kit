export interface IterationRunView {
  iterationId: string;
  workflowId: string | null;
  /** Absolute repo path the iteration operated on (upstream project). */
  repoRoot: string | null;
  goal: string;
  acceptance: string | null;
  runMode: string;
  applyMode: string;
  status: string;
  phase: string;
  tokens: number;
  turnCount: number;
  toolCalls: number;
  lastHeartbeatAt: string | null;
  stalled: boolean;
  planArtifactId: string | null;
  reportArtifactId: string | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface IterationTaskView {
  taskId: string;
  domain: string;
  goal: string;
  acceptance: string;
  status: string;
  phase: string;
  attempt: number;
  coder: string | null;
  risk: string | null;
  changedFiles: string[];
  tokens: number;
  turnCount: number;
  toolCalls: number;
  lastHeartbeatAt: string | null;
  stalled: boolean;
  coderSummary: string | null;
  applyStatus: string | null;
  commit: string | null;
  error: string | null;
  diffArtifactId: string | null;
  transcriptArtifactId: string | null;
  verificationArtifactId: string | null;
  applyArtifactId: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface IterationTurnView {
  iterationId: string;
  taskId: string;
  turn: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  steps: number;
  toolCalls: number;
  tokens: number;
  summary: string | null;
  error: string | null;
  lastEventId: number;
}

export interface IterationEventView {
  eventId: number;
  iterationId: string;
  taskId: string | null;
  turn: number | null;
  step: number | null;
  kind: string;
  status: string | null;
  tool: string | null;
  summary: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface IterationRunWithTasks {
  run: IterationRunView;
  tasks: IterationTaskView[];
  turns: IterationTurnView[];
}

export interface IterationData {
  runs: IterationRunWithTasks[];
  generatedAt: string;
  hasMore: boolean;
}

export interface IterationDetail extends IterationRunWithTasks {
  events: IterationEventView[];
  hasMoreBefore: boolean;
  lastEventId: number;
  generatedAt: string;
}

export interface IterationEventPage {
  events: IterationEventView[];
  hasMore: boolean;
}
