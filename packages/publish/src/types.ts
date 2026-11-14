export type PublishedRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "paused"
  | "cancelled";

export type PublishedArtifactKind = "report" | "artifact" | "revision";

export interface PublishedArtifact {
  artifactId: string;
  version: number;
  kind: PublishedArtifactKind;
  title: string;
  summary: string;
  stageId: string;
  stageName: string;
  agentId: string;
  modelId: string;
  createdAt: string;
  costCny: number;
  tokens: number;
  markdown: string;
  raw: string;
  truncated: boolean;
}

export interface PublishedStage {
  stageId: string;
  name: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  artifactIds: string[];
}

export interface PublishedRun {
  runId: string;
  title: string;
  summary: string;
  workflowId: string;
  workspaceId: string;
  status: PublishedRunStatus;
  runMode: string;
  createdAt: string;
  updatedAt: string;
  costCny: number;
  tokens: number;
  durationMs: number;
  stages: PublishedStage[];
  artifacts: PublishedArtifact[];
}

export interface SiteRunEntry {
  runId: string;
  title: string;
  summary: string;
  workflowId: string;
  status: string;
  runMode: string;
  createdAt: string;
  artifactCount: number;
  costCny: number;
  path: string;
}

export interface SiteIndex {
  version: 1;
  title: string;
  description: string;
  updatedAt: string;
  runs: SiteRunEntry[];
}

export interface SiteOptions {
  title: string;
  description: string;
  repoUrl?: string;
  baseUrl?: string;
}
