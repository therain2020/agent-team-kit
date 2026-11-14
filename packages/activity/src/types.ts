export interface ActivityInput {
  workspaceId?: string;
  runId?: string;
  stageId?: string;
  agentId?: string;
  kind: string;
  status?: string;
  tool?: string;
  summary?: string;
  payload?: unknown;
  createdAt?: string;
}

export interface ActivityEvent {
  eventId: number;
  workspaceId: string;
  runId: string | null;
  stageId: string | null;
  agentId: string | null;
  kind: string;
  status: string | null;
  tool: string | null;
  summary: string | null;
  payload: unknown;
  createdAt: string;
}

export interface ActivityFilter {
  runId?: string;
  agentId?: string;
  kind?: string;
  after?: number;
  before?: number;
  limit?: number;
}
