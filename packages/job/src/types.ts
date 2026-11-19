import type {
  CoderId,
  PriorityClass,
  RunBudgetSpec,
  RunOriginKind,
} from "@kit/core";
import type { PackRunVariant } from "@kit/workflow";

export type JobKind = "packRun" | "iteration";
/** Origins a caller may request; `unknown` is reserved for historical rows. */
export type JobOriginKind = Exclude<RunOriginKind, "unknown">;
/** @deprecated Use `JobOriginKind`; kept for existing string call sites. */
export type JobOrigin = JobOriginKind;

export interface JobOriginRecord {
  kind: JobOriginKind;
  triggerId?: string;
  triggerRunId?: string;
  actor: string;
}

/** `origin` accepts a bare kind (legacy call sites) or a structured record. */
export type StartJobOrigin = JobOriginKind | JobOriginRecord;

export function normalizeJobOrigin(origin?: StartJobOrigin): JobOriginRecord {
  if (origin === undefined) {
    return { kind: "api", actor: "operator:api" };
  }
  if (typeof origin === "string") {
    return {
      kind: origin,
      actor: origin === "autopilot" ? "policy:autopilot" : `operator:${origin}`,
    };
  }
  return {
    kind: origin.kind,
    ...(origin.triggerId ? { triggerId: origin.triggerId } : {}),
    ...(origin.triggerRunId ? { triggerRunId: origin.triggerRunId } : {}),
    actor: origin.actor,
  };
}

export type JobRunMode = "DRY_RUN" | "LIVE";
export type JobApplyMode = "none" | "low" | "low-medium";

export interface MissionInput {
  manager?: string;
  agents?: string[];
  sellers?: string[];
  builders?: string[];
  specialists?: string[];
}

export interface StartJobInput {
  kind: JobKind;
  goal?: string;
  acceptance?: string;
  packDir: string;
  /** Project id from the projects registry; iterations operate on its repo. */
  projectId?: string;
  /** Arbitrary local folder; takes precedence over projectId and is normalized to the main worktree. */
  projectPath?: string;
  workflow?: string;
  domain?: string;
  runMode?: JobRunMode;
  applyMode?: JobApplyMode;
  maxTasks?: number;
  maxRepair?: number;
  coder?: CoderId;
  stub?: boolean;
  budgetCny?: number;
  budget?: RunBudgetSpec;
  /**
   * Deduplicates pack runs as well as iterations: the same key always maps to
   * the same run, so a replayed trigger cannot start a second run.
   */
  dedupeKey?: string;
  origin?: StartJobOrigin;
  evidenceText?: string;
  evidenceArtifactId?: string;
  /** Reads the initial input from a file, taking precedence over text/goal. */
  inputFile?: string;
  /** Pre-generated run id; triggers derive it from the dedupe key for bucketing. */
  runId?: string;
  /** Correlates the run with the event that triggered it (event origins). */
  eventId?: string;
  /** Canary variant metadata selected by the event router. */
  variant?: PackRunVariant;
  /** Workspace scope; defaults to `default`. */
  workspaceId?: string;
  /** Queue priority (60 §2); derived from the triggering event when absent. */
  priority?: PriorityClass;
  mission?: MissionInput;
}

export interface StartJobResult {
  jobId: string;
  kind: JobKind;
  workflowId: string;
  engine: "temporal" | "local";
  runMode: JobRunMode;
  applyMode?: JobApplyMode;
  pack: string;
  workflow?: string;
  requestId?: string;
  mission?: unknown;
  project?: { id: string; name: string; path: string };
  /** True when a run with the same dedupe key already existed; nothing started. */
  deduped?: boolean;
}

export interface JobSummary {
  jobId: string;
  kind: JobKind;
  goal: string | null;
  status: string;
  phase: string | null;
  runMode: string;
  workflowId: string | null;
  /** `unknown` for jobs created before origin was persisted. */
  originKind: RunOriginKind;
  triggerId: string | null;
  triggerRunId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface PendingChange {
  ticketId: string;
  iterationId: string;
  taskId: string;
  domain: string | null;
  goal: string | null;
  risk: "low" | "medium" | "high";
  changedFiles: string[];
  baseSha: string;
  diffArtifactId: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplyPendingResult {
  ticketId: string;
  status: "applied" | "blocked" | "reverted";
  reason: string;
  commit?: string;
  backupDir: string;
  artifactId: string;
}

export class JobError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
