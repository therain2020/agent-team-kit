import {
  type ChangeProposal,
  type ChangeRevertRef,
  type ChangeRisk,
  type ChangeTrigger,
  newChangeProposal,
} from "@kit/core";

/**
 * Adapters translate the two existing self-optimization loops into one
 * `ChangeProposal` shape (85 §3.5). They are pure: no I/O, no apply, no
 * promote. The returned `transitions` replay what each loop already did so the
 * shadow recorder can audit it on the unified state machine.
 *
 * The input types are structural on purpose — `@kit/change` must not depend on
 * `@kit/iteration` or `@kit/evolution`, otherwise the pipeline could grow a
 * code path that applies or promotes directly instead of using the 86
 * single-writer queue.
 */

export interface ChangeTransitionDraft {
  trigger: ChangeTrigger;
  actor: string;
  reason: string;
}

export interface ChangePlan {
  proposal: ChangeProposal;
  transitions: ChangeTransitionDraft[];
}

export interface IterationChangeTask {
  id: string;
  domain: string;
  goal: string;
  acceptance: string;
  risk: ChangeRisk;
}

export interface IterationChangeResult {
  taskId: string;
  verificationPass: boolean;
  applyStatus?: string;
  commit?: string;
  baseSha?: string;
  backupDir?: string;
  error?: string;
  changedFiles?: string[];
}

export interface IterationChangeInput {
  workspaceId: string;
  iterationId: string;
  goal: string;
  task: IterationChangeTask;
  result: IterationChangeResult;
  checks?: string[];
  diffRef?: string | null;
  verificationRef?: string | null;
  /** Overrides the revert record derived from `result`. */
  revert?: ChangeRevertRef | null;
  at?: string;
  actor?: string;
}

/**
 * Maps one iteration task onto a code proposal. The reconstruction is
 * deliberately conservative: it only claims stages the records prove.
 * - verification failed                    → failed
 * - verification passed, apply applied     → promoted
 * - verification passed, apply blocked     → blocked
 * - verification passed, apply skipped/DRY  → evaluated (resting state)
 */
export function adaptIterationChange(input: IterationChangeInput): ChangePlan {
  const at = input.at ?? new Date().toISOString();
  const actor = input.actor ?? "shadow:iterate";
  const { task, result } = input;
  const revert =
    input.revert !== undefined
      ? input.revert
      : result.commit
        ? {
            kind: "code" as const,
            commit: result.commit,
            baseSha: result.baseSha ?? null,
            backupDir: result.backupDir ?? null,
          }
        : null;

  const proposal = newChangeProposal({
    id: `chg_it_${safe(input.workspaceId)}_${safe(input.iterationId)}_${safe(task.id)}`,
    workspaceId: input.workspaceId,
    substrate: "code",
    producer: "iterate",
    signalRefs: [`iterations:${input.iterationId}/${task.id}`],
    hypothesis: task.goal || input.goal,
    acceptance: [task.acceptance],
    risk: task.risk,
    evalPlan: {
      checks: input.checks ?? [],
      evalRefs: input.verificationRef ? [input.verificationRef] : [],
      snapshotRef: null,
    },
    revertRef: result.commit ? `commit:${result.commit}` : null,
    revert,
    contentRef: input.diffRef ?? null,
    sourceRef: {
      kind: "iteration",
      id: input.iterationId,
      taskId: task.id,
    },
    actor,
    now: at,
  });

  const transitions: ChangeTransitionDraft[] = [
    {
      trigger: "evaluate",
      actor,
      reason: `verification ran for ${task.domain}`,
    },
  ];

  if (!result.verificationPass) {
    transitions.push({
      trigger: "fail",
      actor,
      reason: result.error ?? "verification did not pass",
    });
    return { proposal, transitions };
  }

  transitions.push({
    trigger: "evaluation_passed",
    actor,
    reason: "all configured verification checks passed",
  });

  if (result.applyStatus === "applied") {
    transitions.push({
      trigger: "promote",
      actor,
      reason: result.commit
        ? `applied by the single-writer queue (${result.commit})`
        : "applied by the single-writer queue",
    });
  } else if (
    result.applyStatus === "blocked" ||
    result.applyStatus === "reverted"
  ) {
    transitions.push({
      trigger: "block",
      actor,
      reason:
        result.error ?? `apply ${result.applyStatus}; left for operator review`,
    });
  }

  return { proposal, transitions };
}

export interface EvolutionSignalLike {
  signalId: string;
  source: string;
  signal: string;
}

export interface EvolutionCycleLike {
  cycleId: string;
  agentId: string;
  hypothesis: string;
  signalRefs: EvolutionSignalLike[];
  baselineName: string;
  candidateName: string;
  baselinePass: boolean | null;
  candidatePass: boolean | null;
  baselineScore: number | null;
  candidateScore: number | null;
  decision: "promoted" | "canary" | "rejected" | "skipped" | "failed";
  rationale: string;
  autoApplied: boolean;
  createdAt: string;
  evalSnapshotPath?: string;
  evaluatorHash?: string;
  error?: string;
  /** Evolution surface (`context` | `tool` | `architecture`). */
  variantKind?: "context" | "tool" | "architecture" | null;
  /** Promotion approval when the gate required one. */
  approvalRef?: string | null;
  /** Backup written by the promotion; enables instruction rollback. */
  promote?: {
    targetDir: string;
    backupDir: string;
    hash: string;
    approvalRef?: string | null;
  } | null;
}

export interface EvolutionChangeInput {
  workspaceId: string;
  cycle: EvolutionCycleLike;
  /** Overrides the revert record derived from `cycle.promote`. */
  revert?: ChangeRevertRef | null;
  /** Overrides the approval reference recorded on the proposal. */
  approvalRef?: string | null;
  actor?: string;
  at?: string;
}

/**
 * Evolution surfaces map onto the unified substrate enum: agent context
 * instructions are prompts, skills/tools are skills, and role/team structure
 * (team.yaml, workflows, roles) is a workflow change.
 */
function evolutionSubstrate(
  kind: EvolutionCycleLike["variantKind"],
): "prompt" | "skill" | "workflow" {
  if (kind === "architecture") {
    return "workflow";
  }
  if (kind === "tool") {
    return "skill";
  }
  return "prompt";
}

/**
 * Maps one evolution cycle onto a prompt proposal. Skipped cycles are not
 * proposals (nothing was evaluated) and return `null`.
 *
 * - promoted (auto-applied) → evaluated → canary → promoted
 * - canary                  → evaluated → canary (resting, awaits operator)
 * - rejected                → failed (did not beat the baseline)
 * - failed                  → failed
 */
export function adaptEvolutionChange(
  input: EvolutionChangeInput,
): ChangePlan | null {
  const cycle = input.cycle;
  if (cycle.decision === "skipped") {
    return null;
  }
  const at = input.at ?? cycle.createdAt;
  const actor = input.actor ?? "shadow:evolve";
  const revert =
    input.revert !== undefined
      ? input.revert
      : cycle.promote
        ? {
            kind: "instruction" as const,
            targetDir: cycle.promote.targetDir,
            backupDir: cycle.promote.backupDir,
            hash: cycle.promote.hash,
          }
        : null;

  const proposal = newChangeProposal({
    id: `chg_cy_${safe(input.workspaceId)}_${safe(cycle.cycleId)}`,
    workspaceId: input.workspaceId,
    substrate: evolutionSubstrate(
      input.variantKind ?? cycle.variantKind ?? null,
    ),
    producer: "evolve",
    signalRefs: cycle.signalRefs.map(
      (ref) => `evolve:${ref.source}:${ref.signalId}`,
    ),
    hypothesis: cycle.hypothesis || `evolve ${cycle.agentId}`,
    acceptance: [
      `candidate ${cycle.candidateName || "(unnamed)"} must beat baseline ${cycle.baselineName || "(unnamed)"} by at least 0.02`,
      "canary must not regress pass rate, score or cost beyond thresholds",
    ],
    risk: cycle.autoApplied ? "low" : "medium",
    evalPlan: {
      checks: ["baseline_score", "candidate_score", "canary_compare"],
      evalRefs: [cycle.baselineName, cycle.candidateName].filter(Boolean),
      snapshotRef: cycle.evalSnapshotPath ?? null,
    },
    revertRef: cycle.baselineName ? `variant:${cycle.baselineName}` : null,
    revert,
    approvalRef:
      input.approvalRef ??
      cycle.approvalRef ??
      cycle.promote?.approvalRef ??
      null,
    contentRef: null,
    sourceRef: { kind: "evolution", id: cycle.cycleId, taskId: null },
    actor,
    now: at,
  });

  const transitions: ChangeTransitionDraft[] = [
    {
      trigger: "evaluate",
      actor,
      reason: "baseline and candidate scored against the frozen snapshot",
    },
  ];

  if (cycle.decision === "failed") {
    transitions.push({
      trigger: "fail",
      actor,
      reason: cycle.error ?? (cycle.rationale || "evolution cycle failed"),
    });
    return { proposal, transitions };
  }
  if (cycle.decision === "rejected") {
    transitions.push({
      trigger: "fail",
      actor,
      reason: cycle.rationale || "candidate did not beat the baseline",
    });
    return { proposal, transitions };
  }

  transitions.push({
    trigger: "evaluation_passed",
    actor,
    reason: cycle.rationale || "candidate beat the baseline",
  });

  if (cycle.decision === "promoted" && cycle.autoApplied) {
    transitions.push({
      trigger: "canary",
      actor,
      reason: "canary passed its comparison",
    });
    transitions.push({
      trigger: "promote",
      actor,
      reason: "auto-promoted after a passed canary, with a backup",
    });
  } else if (cycle.decision === "promoted") {
    transitions.push({
      trigger: "promote",
      actor,
      reason: "promoted after evaluation",
    });
  } else {
    transitions.push({
      trigger: "canary",
      actor,
      reason: "canary passed; promotion awaits an explicit operator action",
    });
  }

  return { proposal, transitions };
}

/**
 * Stable ids make shadow recording idempotent: replaying the same iteration
 * task or evolution cycle hits the existing proposal instead of duplicating
 * it and its audit trail.
 */
function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
