export type CoderId = "dsh" | "codex" | "opencode" | "command";

export type SandboxMode = "copy" | "worktree" | "snapshot";

export type CoderStreamKind =
  | "session"
  | "turn_start"
  | "step_start"
  | "thinking"
  | "text"
  | "tool_call"
  | "tool_result"
  | "step_end"
  | "turn_end"
  | "final"
  | "error";

export interface CoderStreamEvent {
  kind: CoderStreamKind;
  at: string;
  turn?: number;
  step?: number;
  tool?: string;
  callId?: string;
  status?: string;
  summary?: string;
  tokens?: number;
  payload?: Record<string, unknown>;
}

export interface CoderTurn {
  turn: number;
  startedAt: string;
  finishedAt?: string;
  steps: number;
  toolCalls: number;
  tokens: number;
  summary: string;
  events: CoderStreamEvent[];
}

export interface CoderTask {
  runId: string;
  taskId: string;
  goal: string;
  acceptance: string;
  instructions: string;
  context?: string;
  repoRoot: string;
  sandboxRoot: string;
  timeoutMs?: number;
  envAllowlist?: string[];
  onEvent?: (event: CoderStreamEvent) => void | Promise<void>;
}

export interface CoderProcessResult {
  coder: string;
  ok: boolean;
  exitCode: number | null;
  summary: string;
  transcript: string;
  durationMs: number;
  tokens?: number;
  sessionId?: string;
  error?: string;
  timedOut?: boolean;
  turns?: CoderTurn[];
}

export interface CoderResult extends CoderProcessResult {
  changedFiles: string[];
  diff: string;
  sandbox: {
    mode: SandboxMode;
    baselineSha: string;
    setupLog: string;
  };
}

export interface CoderAdapter {
  id: CoderId;
  available(): Promise<boolean>;
  run(task: CoderTask): Promise<CoderProcessResult>;
}

export interface CoderAvailability {
  id: CoderId;
  available: boolean;
  command?: string;
}

export interface SandboxChanges {
  changedFiles: string[];
  diff: string;
  status: string;
}

export interface Sandbox {
  dir: string;
  mode: SandboxMode;
  baselineSha: string;
  setupLog: string;
  collect(): Promise<SandboxChanges>;
  cleanup(): Promise<void>;
}
