export interface IterationRunView {
  iterationId: string;
  workflowId: string | null;
  goal: string;
  acceptance: string | null;
  runMode: string;
  applyMode: string;
  status: string;
  phase: string;
  tokens: number;
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

export interface IterationRunWithTasks {
  run: IterationRunView;
  tasks: IterationTaskView[];
}

export interface IterationData {
  runs: IterationRunWithTasks[];
  generatedAt: string;
}
