import type { CoderId, IterationTask, TaskPlan } from "@kit/core";

export interface IterationInput {
  iterationId: string;
  /** Temporal workflow id used to start this iteration (dedupe-aware). */
  workflowId?: string;
  workspaceId: string;
  packDir: string;
  goal: string;
  acceptance?: string;
  domain?: string;
  maxTasks: number;
  maxRepair: number;
  runMode: "DRY_RUN" | "LIVE";
  applyMode: "none" | "low" | "low-medium";
  coder?: CoderId;
  stub: boolean;
  budgetCny?: number;
  dedupeKey?: string;
}

export interface PlannedIteration {
  plan: TaskPlan;
  artifactId: string;
  tokens: number;
  costCny: number;
}

export interface RunCoderActivityInput {
  iterationId: string;
  workspaceId: string;
  packDir: string;
  task: IterationTask;
  attempt: number;
  feedback: string;
  runMode: "DRY_RUN" | "LIVE";
  coderOverride?: CoderId;
}

export interface IterationCoderResult {
  taskId: string;
  coder: CoderId;
  ok: boolean;
  summary: string;
  changedFiles: string[];
  diffArtifactId: string;
  resultArtifactId: string;
  transcriptArtifactId: string;
  sandboxDir: string;
  baselineSha: string;
  sandboxMode: "copy" | "worktree" | "snapshot";
  tokens: number;
  error?: string;
}

export interface VerifyTaskActivityInput {
  iterationId: string;
  workspaceId: string;
  packDir: string;
  task: IterationTask;
  sandboxDir: string;
  coderOk: boolean;
  coderSummary: string;
  changedFiles: string[];
}

export interface CheckResult {
  name: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export interface IterationVerificationResult {
  taskId: string;
  pass: boolean;
  feedback: string;
  checks: CheckResult[];
  artifactId: string;
}

export interface ClassifyTaskActivityInput {
  iterationId: string;
  workspaceId: string;
  packDir: string;
  task: IterationTask;
  changedFiles: string[];
  plannedRisk: "low" | "medium" | "high";
}

export interface IterationRiskResult {
  taskId: string;
  risk: "low" | "medium" | "high";
  reasons: string[];
  forbidden: boolean;
}

export interface ApplyTaskActivityInput {
  iterationId: string;
  workspaceId: string;
  task: IterationTask;
  risk: "low" | "medium" | "high";
  forbidden: boolean;
  verificationPass: boolean;
  applyMode: "none" | "low" | "low-medium";
  runMode: "DRY_RUN" | "LIVE";
  diffArtifactId: string;
  baselineSha: string;
  changedFiles: string[];
}

export interface IterationApplyResult {
  taskId: string;
  applied: boolean;
  status: "applied" | "blocked" | "reverted" | "skipped";
  reason: string;
  ticketId: string;
  baseSha: string;
  commit?: string;
  artifactId: string;
}

export interface CleanupInput {
  sandboxDir: string;
}

export interface FailIterationInput {
  iterationId: string;
  workspaceId: string;
  error: string;
}

export interface IterationTaskResult {
  taskId: string;
  domain: string;
  coder: CoderId;
  coderOk: boolean;
  verificationPass: boolean;
  risk: "low" | "medium" | "high";
  applied: boolean;
  reasons: string[];
  error?: string;
  changedFiles: string[];
  tokens?: number;
  baselineSha?: string;
  coderSummary?: string;
  applyStatus?: "applied" | "blocked" | "reverted" | "skipped";
  applyReason?: string;
  commit?: string;
}

export interface ReportIterationInput {
  iterationId: string;
  workspaceId: string;
  goal: string;
  plan: TaskPlan;
  planArtifactId: string;
  tasks: IterationTaskResult[];
}

export interface IterationReportResult {
  reportArtifactId: string;
  fitnessArtifactId: string;
  status: "succeeded" | "partial" | "failed";
}

export interface IterationResult extends IterationReportResult {
  iterationId: string;
  planArtifactId: string;
  tasks: IterationTaskResult[];
}
