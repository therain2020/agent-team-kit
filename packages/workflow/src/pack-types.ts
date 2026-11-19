import type {
  PackTool,
  RubricDimension,
  RunBudgetSpec,
  RunOrigin,
} from "@kit/core";

export interface StageGate {
  ref: string;
  dimensions: Record<string, RubricDimension>;
}

export interface RevisionSpec {
  agentId: string;
  modelAlias: string;
  instructions: string;
}

export interface PackApprovalSpec {
  mode: "required" | "auto" | "never";
  position: "before" | "after";
  riskClass: "low" | "medium" | "high";
  ttlMs: number;
  notify?: { webhook?: string; tokenEnv?: string };
  autoApproveWhen?: {
    maxRunCostCny?: number;
    riskClass?: Array<"low" | "medium" | "high">;
    stages?: string[];
  };
}

export interface PackStageSpec {
  stageId: string;
  stageName: string;
  type: "workflow" | "agent" | "coder";
  agentId?: string;
  coder?: "dsh" | "codex" | "opencode" | "command";
  goal?: string;
  acceptance?: string;
  modelAlias?: string;
  instructions?: string;
  tools?: string[];
  packTools?: PackTool[];
  timeoutMs?: number;
  gate?: StageGate;
  includeInitialInput?: boolean;
  inputFromStageId?: string;
  inputsFromStageIds?: string[];
  position?: { x: number; y: number };
  revision?: RevisionSpec;
  approval?: PackApprovalSpec;
  failureMode?: "fail_open" | "fail_closed";
}

export interface PackRunVariant {
  role: "champion" | "canary";
  variantId: string;
  trafficPercent: number;
}

export interface PackRunInput {
  runId: string;
  eventId: string;
  workspaceId: string;
  workflowId: string;
  workflowVersion: string;
  runMode: "DRY_RUN" | "LIVE";
  initialInput: string;
  stages: PackStageSpec[];
  stub: boolean;
  origin?: RunOrigin;
  maxConcurrency?: number;
  variant?: PackRunVariant;
  budget?: RunBudgetSpec;
  delivery?: {
    channel: "im" | "email" | "local_file" | "webhook";
    approval?: "never" | "required_if_published";
  };
}

export interface PreparePackRunInput {
  runId: string;
  eventId: string;
  workspaceId: string;
  workflowId: string;
  workflowVersion: string;
  runMode: "DRY_RUN" | "LIVE";
  stages: Array<{ stageId: string; name: string; agentId?: string }>;
  origin?: RunOrigin;
  budget?: RunBudgetSpec;
}

export interface PackStageExecutionInput extends PackStageSpec {
  runId: string;
  workspaceId: string;
  runMode: "DRY_RUN" | "LIVE";
  inputText: string;
  inputArtifactId?: string;
  inputArtifactIds?: string[];
  evidenceText?: string;
  stub: boolean;
  gateApproved?: boolean;
}

export interface PackStageExecutionResult {
  artifactId: string;
  text: string;
  reused: boolean;
  effectiveInputArtifactId?: string;
  effectiveInputText?: string;
  approvalRequired?: boolean;
  approvalRequestId?: string;
  approvalExpiresAt?: string;
  autoApproved?: boolean;
  gateFailed?: boolean;
  budgetPaused?: boolean;
  budgetSummary?: string;
  blockingBudgetId?: string;
}

export interface RequestApprovalInput {
  runId: string;
  workspaceId: string;
  runMode: "DRY_RUN" | "LIVE";
  stageId: string;
  stageName: string;
  requestType:
    | "stage_before"
    | "stage_after"
    | "gate_failure"
    | "budget_exceeded";
  approval: PackApprovalSpec;
  summary: string;
  draftArtifactId?: string;
  options: string[];
}

export interface RequestApprovalResult {
  required: boolean;
  autoApproved?: boolean;
  requestId?: string;
  expiresAt?: string;
  runCostCny: number;
}

export interface PackRunResult {
  runId: string;
  artifactIds: string[];
}
