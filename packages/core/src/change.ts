import { z } from "zod";
import { newId } from "./ids";

/**
 * Unified change pipeline contract (85 §2, §3.5; 70 §3.2; D-51/D-52).
 *
 * Both self-optimization loops — task iteration (`iterate`) and prompt/workflow
 * evolution (`evolve`) — emit the same `ChangeProposal` and move it along one
 * state machine. This module is pure contract + transitions: it records what
 * was proposed, why, how it was evaluated and where it ended up. It never
 * applies or promotes anything; those writes stay in the 86 single-writer
 * queue (`kit-apply`, cross-process apply lock).
 *
 * Rules enforced here:
 * - Unknown substrates, producers or states are rejected by schema.
 * - Every transition is explicit; an illegal trigger throws instead of being
 *   silently ignored, so audit rows cannot be forged by a bad caller.
 * - Failure states (`failed`, `blocked`) are revertible via `rollback`, which
 *   is the only path back to the terminal `rolled_back` state.
 * - Promotion requires an evaluation audit trail, a revert reference, and an
 *   approval reference for high-risk changes (85 hard contract 3 and 4).
 */

export const changeSubstrateSchema = z.enum([
  "code",
  "prompt",
  "workflow",
  "skill",
]);

export type ChangeSubstrate = z.infer<typeof changeSubstrateSchema>;

export const changeProducerSchema = z.enum(["iterate", "evolve", "human"]);

export type ChangeProducer = z.infer<typeof changeProducerSchema>;

export const changeRiskSchema = z.enum(["low", "medium", "high"]);

export type ChangeRisk = z.infer<typeof changeRiskSchema>;

export const changeStateSchema = z.enum([
  "proposed",
  "evaluating",
  "evaluated",
  "canary",
  "promoted",
  "observed",
  "rolled_back",
  /**
   * Explicit failure state: evaluation, canary or observation did not hold up.
   * Revertible through `rollback`.
   */
  "failed",
  /**
   * Explicit failure state: the pipeline could not proceed (conflicting base,
   * denied approval, single-writer block). Revertible through `rollback`.
   */
  "blocked",
]);

export type ChangeState = z.infer<typeof changeStateSchema>;

export const changeTriggerSchema = z.enum([
  "submit",
  "evaluate",
  "evaluation_passed",
  "canary",
  "promote",
  "observe",
  "rollback",
  "fail",
  "block",
]);

export type ChangeTrigger = z.infer<typeof changeTriggerSchema>;

export const changeEvalPlanSchema = z.object({
  /** Ordered checks the proposal must pass (typecheck, test, rubric, ...). */
  checks: z.array(z.string().trim().min(1)).default([]),
  /** Frozen evaluation snapshot or variant references used for the verdict. */
  evalRefs: z.array(z.string().trim().min(1)).default([]),
  /** Required for evolve: the cycle-scoped frozen snapshot (70 §3.3). */
  snapshotRef: z.string().trim().min(1).nullable().default(null),
});

export type ChangeEvalPlan = z.infer<typeof changeEvalPlanSchema>;

/**
 * Structured, executable revert reference (85 §3.6). `revertRef` stays the
 * compact display pointer; this record is what a recovery kernel executes.
 *
 * - `code`: revert the recorded commit only (never `HEAD` blindly).
 * - `instruction`: restore the backed-up variant files after verifying the
 *   backup hash.
 */
export const changeRevertCodeSchema = z.object({
  kind: z.literal("code"),
  commit: z.string().trim().min(1),
  baseSha: z.string().trim().min(1).nullable().default(null),
  backupDir: z.string().trim().min(1).nullable().default(null),
});

export const changeRevertInstructionSchema = z.object({
  kind: z.literal("instruction"),
  targetDir: z.string().trim().min(1),
  backupDir: z.string().trim().min(1),
  /** sha256 over the sorted backup file hashes; verified before restoring. */
  hash: z.string().trim().min(1),
});

export const changeRevertRefSchema = z.discriminatedUnion("kind", [
  changeRevertCodeSchema,
  changeRevertInstructionSchema,
]);

export type ChangeRevertRef = z.infer<typeof changeRevertRefSchema>;

export const changeSourceRefSchema = z.object({
  kind: z.enum(["iteration", "evolution", "human"]),
  id: z.string().min(1),
  taskId: z.string().min(1).nullable().default(null),
});

export type ChangeSourceRef = z.infer<typeof changeSourceRefSchema>;

export const changeOutcomeSchema = z.object({
  state: changeStateSchema,
  summary: z.string().default(""),
  decidedBy: z.string().trim().min(1).nullable().default(null),
  decidedAt: z.string().datetime().nullable().default(null),
});

export type ChangeOutcome = z.infer<typeof changeOutcomeSchema>;

/** One audit row. `from` is null for the creation/submission record. */
export const changeTransitionSchema = z.object({
  auditId: z.string().min(1),
  from: changeStateSchema.nullable(),
  to: changeStateSchema,
  trigger: changeTriggerSchema,
  actor: z.string().trim().min(1),
  reason: z.string().default(""),
  at: z.string().datetime(),
});

export type ChangeTransition = z.infer<typeof changeTransitionSchema>;

export const changeProposalSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1).default("default"),
  /** What kind of artifact this proposal would change. */
  substrate: changeSubstrateSchema,
  /** Which loop produced it; adapters keep this stable across both loops. */
  producer: changeProducerSchema,
  /** Opaque, stable references to the signals that motivated the change. */
  signalRefs: z.array(z.string().min(1)).default([]),
  hypothesis: z.string().trim().min(1).max(8000),
  /** Acceptance criteria; at least one is required. */
  acceptance: z.array(z.string().trim().min(1)).min(1),
  risk: changeRiskSchema,
  evalPlan: changeEvalPlanSchema.default({
    checks: [],
    evalRefs: [],
    snapshotRef: null,
  }),
  /** Commit/variant the change can be rolled back to. */
  revertRef: z.string().min(1).nullable().default(null),
  /** Executable revert record; see {@link changeRevertRefSchema}. */
  revert: changeRevertRefSchema.nullable().default(null),
  budgetRef: z.string().min(1).nullable().default(null),
  approvalRef: z.string().min(1).nullable().default(null),
  outcome: changeOutcomeSchema.nullable().default(null),
  /**
   * D-52: the row is the source of truth; large content (diffs, candidate
   * documents) lives in the content-addressed blob store and is referenced
   * here.
   */
  contentRef: z.string().min(1).nullable().default(null),
  sourceRef: changeSourceRefSchema.nullable().default(null),
  state: changeStateSchema.default("proposed"),
  /** Append-only audit trail; each entry mirrors one transition row. */
  history: z.array(changeTransitionSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().nonnegative().default(0),
});

export type ChangeProposal = z.infer<typeof changeProposalSchema>;

export const newChangeProposalInputSchema = z.object({
  id: z.string().min(1).optional(),
  workspaceId: z.string().min(1).default("default"),
  substrate: changeSubstrateSchema,
  producer: changeProducerSchema,
  signalRefs: z.array(z.string().min(1)).default([]),
  hypothesis: z.string().trim().min(1).max(8000),
  acceptance: z.array(z.string().trim().min(1)).min(1),
  risk: changeRiskSchema,
  evalPlan: changeEvalPlanSchema.optional(),
  revertRef: z.string().min(1).nullable().default(null),
  revert: changeRevertRefSchema.nullable().default(null),
  budgetRef: z.string().min(1).nullable().default(null),
  approvalRef: z.string().min(1).nullable().default(null),
  contentRef: z.string().min(1).nullable().default(null),
  sourceRef: changeSourceRefSchema.nullable().default(null),
  /** Actor recorded on the submission audit row. */
  actor: z.string().trim().min(1).default("system"),
  now: z.string().datetime().optional(),
});

export type NewChangeProposalInput = z.input<
  typeof newChangeProposalInputSchema
>;

/** Builds a proposal in `proposed` with its submission audit row. */
export function newChangeProposal(
  input: NewChangeProposalInput,
): ChangeProposal {
  const parsed = newChangeProposalInputSchema.parse(input);
  const at = parsed.now ?? new Date().toISOString();
  return changeProposalSchema.parse({
    id: parsed.id ?? newId("chg"),
    workspaceId: parsed.workspaceId,
    substrate: parsed.substrate,
    producer: parsed.producer,
    signalRefs: parsed.signalRefs,
    hypothesis: parsed.hypothesis,
    acceptance: parsed.acceptance,
    risk: parsed.risk,
    evalPlan: parsed.evalPlan,
    revertRef: parsed.revertRef,
    revert: parsed.revert,
    budgetRef: parsed.budgetRef,
    approvalRef: parsed.approvalRef,
    outcome: null,
    contentRef: parsed.contentRef,
    sourceRef: parsed.sourceRef,
    state: "proposed",
    history: [
      {
        auditId: newId("chgtr"),
        from: null,
        to: "proposed",
        trigger: "submit",
        actor: parsed.actor,
        reason: "",
        at,
      },
    ],
    createdAt: at,
    updatedAt: at,
    version: 0,
  });
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Allowed transitions. `rolled_back` is terminal. `evaluated` and `canary` are
 * the only states that may promote; `failed` and `blocked` can only roll back.
 */
export const CHANGE_TRANSITIONS: Readonly<
  Record<ChangeState, Readonly<Partial<Record<ChangeTrigger, ChangeState>>>>
> = Object.freeze({
  proposed: {
    evaluate: "evaluating",
    fail: "failed",
    block: "blocked",
    rollback: "rolled_back",
  },
  evaluating: {
    evaluation_passed: "evaluated",
    fail: "failed",
    block: "blocked",
    rollback: "rolled_back",
  },
  evaluated: {
    canary: "canary",
    promote: "promoted",
    fail: "failed",
    block: "blocked",
    rollback: "rolled_back",
  },
  canary: {
    promote: "promoted",
    fail: "failed",
    block: "blocked",
    rollback: "rolled_back",
  },
  promoted: {
    observe: "observed",
    fail: "failed",
    rollback: "rolled_back",
  },
  observed: {
    fail: "failed",
    rollback: "rolled_back",
  },
  failed: {
    rollback: "rolled_back",
  },
  blocked: {
    evaluate: "evaluating",
    rollback: "rolled_back",
  },
  rolled_back: {},
});

/** States from which promotion is legal. */
export const CHANGE_PROMOTION_STATES: readonly ChangeState[] = Object.freeze([
  "evaluated",
  "canary",
]);

export function allowedChangeTransitions(state: ChangeState): ChangeTrigger[] {
  return Object.keys(CHANGE_TRANSITIONS[state]) as ChangeTrigger[];
}

export function nextChangeState(
  state: ChangeState,
  trigger: ChangeTrigger,
): ChangeState | null {
  return CHANGE_TRANSITIONS[state][trigger] ?? null;
}

export function isFailureState(state: ChangeState): boolean {
  return state === "failed" || state === "blocked";
}

/** Every state except `rolled_back` can still be rolled back. */
export function isRevertible(state: ChangeState): boolean {
  return state !== "rolled_back";
}

export class ChangeTransitionError extends Error {
  constructor(
    readonly code: "illegal_transition",
    readonly from: ChangeState,
    readonly trigger: ChangeTrigger,
    message: string,
  ) {
    super(message);
    this.name = "ChangeTransitionError";
  }
}

export const changeTransitionInputSchema = z.object({
  trigger: changeTriggerSchema,
  actor: z.string().trim().min(1),
  reason: z.string().default(""),
  at: z.string().datetime().optional(),
});

export type ChangeTransitionInput = z.input<typeof changeTransitionInputSchema>;

/** Applies a legal transition and appends its audit row. */
export function applyChangeTransition(
  proposal: ChangeProposal,
  input: ChangeTransitionInput,
): ChangeProposal {
  const parsed = changeTransitionInputSchema.parse(input);
  const from = proposal.state;
  const to = nextChangeState(from, parsed.trigger);
  if (!to) {
    throw new ChangeTransitionError(
      "illegal_transition",
      from,
      parsed.trigger,
      `cannot apply ${parsed.trigger} to a proposal in state ${from}`,
    );
  }
  const at = parsed.at ?? new Date().toISOString();
  const transition: ChangeTransition = {
    auditId: newId("chgtr"),
    from,
    to,
    trigger: parsed.trigger,
    actor: parsed.actor,
    reason: parsed.reason,
    at,
  };
  const outcome: ChangeOutcome | null =
    to === "promoted" ||
    to === "observed" ||
    to === "rolled_back" ||
    to === "failed" ||
    to === "blocked"
      ? {
          state: to,
          summary: parsed.reason,
          decidedBy: parsed.actor,
          decidedAt: at,
        }
      : proposal.outcome;
  return changeProposalSchema.parse({
    ...proposal,
    state: to,
    history: [...proposal.history, transition],
    outcome,
    updatedAt: at,
    version: proposal.version + 1,
  });
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export class ChangeGuardError extends Error {
  constructor(
    readonly code:
      | "illegal_state"
      | "missing_evaluation"
      | "missing_revert_ref"
      | "missing_approval"
      | "terminal_state",
    message: string,
  ) {
    super(message);
    this.name = "ChangeGuardError";
  }
}

/**
 * Promotion gate. Callers that bridge to the 86 apply/promote queue must call
 * this first; a proposal without an evaluation audit trail, a revert reference,
 * or (for high risk) an approval reference may not be promoted.
 */
export function assertPromotionAllowed(proposal: ChangeProposal): void {
  if (proposal.state !== "evaluated" && proposal.state !== "canary") {
    throw new ChangeGuardError(
      "illegal_state",
      `proposal ${proposal.id} is ${proposal.state}; only an evaluated or canary proposal can be promoted`,
    );
  }
  const evaluated = proposal.history.some(
    (entry) =>
      entry.trigger === "evaluation_passed" && entry.to === "evaluated",
  );
  if (!evaluated) {
    throw new ChangeGuardError(
      "missing_evaluation",
      `proposal ${proposal.id} has no evaluation audit row`,
    );
  }
  if (!proposal.revertRef) {
    throw new ChangeGuardError(
      "missing_revert_ref",
      `proposal ${proposal.id} has no revertRef; an irreversible change cannot be promoted`,
    );
  }
  if (proposal.risk === "high" && !proposal.approvalRef) {
    throw new ChangeGuardError(
      "missing_approval",
      `proposal ${proposal.id} is high risk and has no approvalRef`,
    );
  }
}

/** Rollback gate: every non-terminal state is revertible. */
export function assertRollbackAllowed(proposal: ChangeProposal): void {
  if (!isRevertible(proposal.state)) {
    throw new ChangeGuardError(
      "terminal_state",
      `proposal ${proposal.id} is already rolled back`,
    );
  }
}
