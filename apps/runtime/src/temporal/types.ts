export interface DemoInput {
  runId: string;
  eventId: string;
  workspaceId: string;
  sleepMs?: number;
}

export interface PreparedRun {
  stage1Id: string;
  stage2Id: string;
}

export interface StageInput {
  runId: string;
  workspaceId: string;
  stageId: string;
  stageName: string;
  inputArtifactId?: string;
  sleepMs?: number;
}

export interface StageResult {
  artifactId: string;
  reused: boolean;
}

export interface FinishInput {
  runId: string;
}

export interface DemoResult {
  runId: string;
  artifacts: string[];
}
