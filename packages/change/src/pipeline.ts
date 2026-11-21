import {
  CHANGE_PROMOTION_STATES,
  type ChangeProposal,
  assertPromotionAllowed,
} from "@kit/core";
import type { ChangeProposalService } from "@kit/store";
import type { ChangePlan, ChangeTransitionDraft } from "./adapters";

/**
 * Orchestrates a proposal through the unified state machine. It persists every
 * transition (and therefore every audit row) through the store service.
 *
 * The pipeline deliberately contains no apply or promote call. Bridging a
 * proposal to the 86 single-writer queue is a separate, later step; that bridge
 * must call {@link requirePromotableProposal} first, which is what makes
 * bypassing the audit trail impossible.
 */

export class ChangePipelineError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "version_conflict"
      | "illegal_transition"
      | "stale_transition",
    message: string,
  ) {
    super(message);
    this.name = "ChangePipelineError";
  }
}

export class ChangePipeline {
  constructor(private readonly service: ChangeProposalService) {}

  /**
   * Creates the proposal and replays the adapter's reconstructed stages.
   * A deterministic id that already advanced (version > 0) is returned as-is:
   * replaying a source record must never overwrite audited history.
   */
  async record(plan: ChangePlan): Promise<ChangeProposal> {
    const created = await this.service.create(plan.proposal);
    if (created.version > 0) {
      return created;
    }
    return await this.play(created.id, plan.transitions);
  }

  async play(
    proposalId: string,
    transitions: readonly ChangeTransitionDraft[],
  ): Promise<ChangeProposal> {
    let proposal = await this.service.get(proposalId);
    if (!proposal) {
      throw new ChangePipelineError(
        "not_found",
        `change proposal ${proposalId} not found`,
      );
    }
    for (const draft of transitions) {
      if (draft.trigger === "promote") {
        assertPromotionAllowed(proposal);
      }
      proposal = await this.transition(proposalId, draft);
    }
    return proposal;
  }

  async transition(
    proposalId: string,
    draft: ChangeTransitionDraft,
  ): Promise<ChangeProposal> {
    const result = await this.service.transition({
      proposalId,
      trigger: draft.trigger,
      actor: draft.actor,
      reason: draft.reason,
    });
    if (!result.ok) {
      throw new ChangePipelineError(
        result.code,
        `change proposal ${proposalId}: ${result.code}`,
      );
    }
    return result.proposal;
  }
}

/**
 * Promotion gate for any future bridge to the 86 apply/promote queue.
 * Throws when the proposal is not in a promotable state, has no evaluation
 * audit row, has no revert reference, or is high risk without approval.
 */
export async function requirePromotableProposal(
  service: ChangeProposalService,
  proposalId: string,
): Promise<ChangeProposal> {
  const proposal = await service.get(proposalId);
  if (!proposal) {
    throw new ChangePipelineError(
      "not_found",
      `change proposal ${proposalId} not found`,
    );
  }
  assertPromotionAllowed(proposal);
  return proposal;
}

/** Exposed for UI/CLI callers that render "can this be promoted?". */
export function promotableStates(): readonly string[] {
  return CHANGE_PROMOTION_STATES;
}
