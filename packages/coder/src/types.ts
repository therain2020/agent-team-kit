export type CoderId = "dsh" | "codex" | "opencode" | "command";

export type SandboxMode = "copy" | "worktree" | "snapshot";

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
