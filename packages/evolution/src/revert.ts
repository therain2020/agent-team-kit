import { type ChangeState, isRevertible } from "@kit/core";

/**
 * Unified change rollback (85 §3.5, 70 §3.6).
 *
 * A promoted or canaried change is reverted by moving its `ChangeProposal`
 * through the same state machine every other change uses, using the proposal's
 * `revertRef` as the recorded rollback target. There is deliberately no second
 * rollback mechanism here: a proposal without a `revertRef` cannot be promoted
 * in the first place (`assertPromotionAllowed`), so a proposal that lacks one
 * is refused rather than reverted through an unaudited side channel.
 */

export interface RevertibleProposal {
  id: string;
  state: ChangeState;
  revertRef: string | null;
}

export interface ChangeRevertResult {
  ok: boolean;
  transition?: { auditId: string };
  code?: string;
  current?: RevertibleProposal | null;
}

/**
 * Structural view of `ChangeProposalService`. Keeping it structural lets the
 * evolution plane depend on the contract (audited transition) without owning a
 * second store implementation, and lets tests inject a faithful fake.
 */
export interface ChangeRevertService {
  get(proposalId: string): Promise<RevertibleProposal | null>;
  transition(input: {
    proposalId: string;
    trigger: "rollback";
    actor: string;
    reason: string;
  }): Promise<ChangeRevertResult>;
}

export type RevertStatus =
  | "rolled_back"
  | "already_rolled_back"
  | "skipped"
  | "failed";

export interface RevertOutcome {
  status: RevertStatus;
  proposalId: string | null;
  revertRef: string | null;
  reason: string;
  fromState?: ChangeState;
  auditId?: string;
  /** Existing canary state machine rollback, when an active canary matched. */
  canary?: {
    status: "rolled_back" | "skipped" | "failed";
    reason: string;
  };
}

export interface RevertChangeInput {
  proposalId: string | null | undefined;
  /** Change identifier recorded on runs; used in the refusal reason. */
  changeId?: string;
  reason: string;
  actor?: string;
}

export async function revertChangeProposal(
  service: ChangeRevertService,
  input: RevertChangeInput,
): Promise<RevertOutcome> {
  const actor = input.actor ?? "evolution:attribution";
  const proposalId = input.proposalId?.trim() || null;
  if (!proposalId) {
    return {
      status: "skipped",
      proposalId: null,
      revertRef: null,
      reason: `no unified change proposal is linked to ${input.changeId ?? "this change"}; rollback left to the operator`,
    };
  }

  const proposal = await service.get(proposalId);
  if (!proposal) {
    return {
      status: "skipped",
      proposalId,
      revertRef: null,
      reason: `change proposal ${proposalId} was not found`,
    };
  }
  if (proposal.state === "rolled_back") {
    return {
      status: "already_rolled_back",
      proposalId,
      revertRef: proposal.revertRef,
      reason: `change proposal ${proposalId} is already rolled back`,
    };
  }
  if (!proposal.revertRef) {
    return {
      status: "skipped",
      proposalId,
      revertRef: null,
      fromState: proposal.state,
      reason: `change proposal ${proposalId} has no revertRef; refusing an unaudited rollback`,
    };
  }
  if (!isRevertible(proposal.state)) {
    return {
      status: "skipped",
      proposalId,
      revertRef: proposal.revertRef,
      fromState: proposal.state,
      reason: `change proposal ${proposalId} is in terminal state ${proposal.state}`,
    };
  }

  const result = await service.transition({
    proposalId,
    trigger: "rollback",
    actor,
    reason: input.reason,
  });
  if (!result.ok) {
    return {
      status: "failed",
      proposalId,
      revertRef: proposal.revertRef,
      fromState: proposal.state,
      reason: `rollback of ${proposalId} failed: ${result.code ?? "unknown"}`,
    };
  }
  return {
    status: "rolled_back",
    proposalId,
    revertRef: proposal.revertRef,
    fromState: proposal.state,
    ...(result.transition ? { auditId: result.transition.auditId } : {}),
    reason: `rolled back ${proposalId} to ${proposal.revertRef}`,
  };
}
