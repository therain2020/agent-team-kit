import type { RubricDimension } from "@kit/core";

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
  type: "workflow" | "agent";
  agentId?: string;
  modelAlias?: string;
  instructions?: string;
  tools?: string[];
  gate?: StageGate;
  includeInitialInput?: boolean;
  inputFromStageId?: string;
  revision?: RevisionSpec;
  approval?: PackApprovalSpec;
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
}

export interface PreparePackRunInput {
  runId: string;
  eventId: string;
  workspaceId: string;
  workflowId: string;
  workflowVersion: string;
  runMode: "DRY_RUN" | "LIVE";
  stages: Array<{ stageId: string; name: string }>;
}

export interface PackStageExecutionInput extends PackStageSpec {
  runId: string;
  workspaceId: string;
  runMode: "DRY_RUN" | "LIVE";
  inputText: string;
  inputArtifactId?: string;
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
}

export interface RequestApprovalInput {
  runId: string;
  workspaceId: string;
  runMode: "DRY_RUN" | "LIVE";
  stageId: string;
  stageName: string;
  requestType: "stage_before" | "stage_after" | "gate_failure";
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
