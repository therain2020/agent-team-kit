import {
  ChangeGuardError,
  type ChangeProposal,
  type ChangeRisk,
  assertPromotionAllowed,
} from "@kit/core";
import type { ApprovalRecord, ApprovalService } from "./approval-service";
import type { ChangeProposalService } from "./change-service";
import type { SqlClient } from "./db";
import { type OpOrigin, appendOp, findOpByKey } from "./op-log";

/**
 * Bridges high-risk `ChangeProposal`s onto the approvals entity (85 §2 hard
 * contract 3, §3.7; 85.3.5.5).
 *
 * Code and instruction changes share one queue, one set of semantics and one
 * audit trail. This service only orchestrates the two existing services:
 * `ApprovalService` owns idempotent enqueue and compare-and-set decisions;
 * `ChangeProposalService` owns the state machine and its audit rows. It never
 * applies or promotes anything itself — on approval it records `approvalRef`
 * and advances the proposal to `promoted` through the same legal transition a
 * human operator would use.
 *
 * Change-scoped approvals carry `change_id` and use a synthetic `run_id`
 * (`change:<changeId>`) because the approvals table keys on a run. Every
 * inbox query keeps rows with a `change_id` regardless of run status.
 */

/** Approval kind for pipeline changes; distinguishes them from stage gates. */
export const CHANGE_APPROVAL_KIND = "change_proposal";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SLA_MS = 24 * 60 * 60 * 1000;

/** Only `high` risk exceeds auto-apply (85 §3.4); unknown classes stay high. */
export function changeRequiresApproval(risk: ChangeRisk | string): boolean {
  return risk !== "low" && risk !== "medium";
}

/** Deterministic id makes `request` idempotent across retries and backfill. */
export function changeApprovalIdFor(changeId: string): string {
  return `apr_chg_${changeId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** Synthetic run key so change approvals satisfy the run-keyed table. */
export function changeApprovalRunId(changeId: string): string {
  return `change:${changeId}`;
}

export interface ChangeApprovalRequestOptions {
  /** Actor shown as the requester; defaults to the proposal's submitter. */
  requester?: string;
  expiresAt?: string;
  slaDueAt?: string;
  now?: string;
}

export interface ChangeApprovalDecisionInput {
  approvalId: string;
  status: "approved" | "rejected";
  decisionBy: string;
  reason: string;
  /** Version the caller read; defaults to the current row version. */
  expectedVersion?: number;
  /** Op-log ledger key; a retry replays the first decision. */
  idempotencyKey?: string;
  /** Op-log origin for the ledger write (defaults to `cli`). */
  origin?: OpOrigin;
  at?: string;
}

export type ChangeApprovalErrorCode =
  | "not_found"
  | "not_change"
  | "idempotency_conflict"
  | "not_pending"
  | "expired"
  | "self_approval"
  | "version_conflict"
  | "illegal_change";

export type ChangeApprovalDecisionResult =
  | {
      ok: true;
      record: ApprovalRecord;
      proposal: ChangeProposal;
      duplicate: boolean;
    }
  | {
      ok: false;
      code: ChangeApprovalErrorCode;
      current: ApprovalRecord | null;
      message: string;
    };

export interface ChangeApprovalServiceDeps {
  sql: SqlClient;
  approvals: ApprovalService;
  proposals: ChangeProposalService;
}

export class ChangeApprovalService {
  constructor(private readonly store: ChangeApprovalServiceDeps) {}

  /**
   * Queues the ApprovalRequest for a high-risk proposal. Returns null when the
   * proposal does not exist, is already rolled back, or is below the approval
   * threshold. Idempotent: re-requesting the same change keeps the first row.
   */
  async request(
    changeId: string,
    options: ChangeApprovalRequestOptions = {},
  ): Promise<ApprovalRecord | null> {
    const proposal = await this.store.proposals.get(changeId);
    if (!proposal || proposal.state === "rolled_back") {
      return null;
    }
    if (!changeRequiresApproval(proposal.risk)) {
      return null;
    }
    const now = options.now ?? new Date().toISOString();
    const base = Date.parse(now);
    const requester =
      options.requester ?? proposal.history[0]?.actor ?? "system";
    return await this.store.approvals.enqueue({
      approvalId: changeApprovalIdFor(changeId),
      workspaceId: proposal.workspaceId,
      runId: changeApprovalRunId(changeId),
      kind: CHANGE_APPROVAL_KIND,
      requester,
      payloadRef: null,
      slaDueAt:
        options.slaDueAt ?? new Date(base + DEFAULT_SLA_MS).toISOString(),
      expiresAt:
        options.expiresAt ?? new Date(base + DEFAULT_TTL_MS).toISOString(),
      substrate: proposal.substrate,
      changeId,
      createdAt: now,
    });
  }

  /**
   * Decides a change approval and resumes or terminates the proposal.
   *
   * Reuses the approvals CAS so exactly one concurrent decision wins. Replay
   * (same decision again, or the same `idempotencyKey`) returns
   * `duplicate: true` and converges the proposal, which keeps a crash between
   * the decision and the transition harmless.
   */
  async decide(
    input: ChangeApprovalDecisionInput,
  ): Promise<ChangeApprovalDecisionResult> {
    const at = input.at ?? new Date().toISOString();
    const current = await this.store.approvals.get(input.approvalId);
    if (!current) {
      return fail("not_found", null, "approval not found");
    }
    if (!current.changeId) {
      return fail(
        "not_change",
        current,
        "approval is not linked to a change proposal",
      );
    }

    const key = input.idempotencyKey?.trim() || null;
    if (key) {
      const existing = await findOpByKey(
        { sql: this.store.sql },
        current.workspaceId,
        key,
      );
      if (existing) {
        if (
          existing.entityKind !== "approval" ||
          existing.entityId !== input.approvalId
        ) {
          return fail(
            "idempotency_conflict",
            current,
            `idempotency key "${key}" is already bound to another decision`,
          );
        }
        return await this.settle(current, at, true);
      }
    }

    // A completed equivalent decision is a replay, not an error: converge the
    // proposal so a retry after a crash still resumes/terminates the pipeline.
    if (current.status === input.status) {
      return await this.settle(current, at, true);
    }
    if (current.status !== "queued") {
      return fail("not_pending", current, `approval is ${current.status}`);
    }
    if (current.expiresAt && Date.parse(current.expiresAt) <= Date.parse(at)) {
      return fail(
        "expired",
        current,
        "approval expired without a decision; re-request the change",
      );
    }
    if (sameActor(current.requester, input.decisionBy)) {
      return fail(
        "self_approval",
        current,
        "the requester cannot approve their own change",
      );
    }

    // Validate before consuming the CAS so an un-promotable change leaves the
    // request queued for the operator instead of approving a dead proposal.
    const guard = await this.guardDecision(current, input.status);
    if (!guard.ok) {
      return guard;
    }

    const decided = await this.store.approvals.decide({
      approvalId: input.approvalId,
      expectedVersion: input.expectedVersion ?? current.version,
      status: input.status,
      decisionBy: input.decisionBy,
      decisionReason: input.reason,
      at,
    });
    if (!decided.ok) {
      if (
        decided.code === "not_pending" &&
        decided.current?.status === input.status
      ) {
        return await this.settle(decided.current, at, true);
      }
      return fail(
        decided.code,
        decided.current,
        decided.code === "version_conflict"
          ? "approval version conflict"
          : `approval is ${decided.current?.status ?? "not pending"}`,
      );
    }

    const settled = await this.settle(decided.record, at, false);
    if (!settled.ok) {
      return settled;
    }

    if (key) {
      await appendOp(
        { sql: this.store.sql },
        {
          workspaceId: decided.record.workspaceId,
          entityKind: "approval",
          entityId: input.approvalId,
          op: "approval.decide",
          actor: input.decisionBy,
          origin: input.origin ?? "cli",
          idempotencyKey: key,
          payload: {
            approvalId: input.approvalId,
            changeId: decided.record.changeId,
            status: input.status,
            version: decided.record.version,
            decisionBy: input.decisionBy,
            decisionAt: decided.record.decisionAt,
            decisionReason: decided.record.decisionReason,
          },
          createdAt: at,
        },
      );
    }

    await this.appendAudit(settled.record, at);
    return settled;
  }

  /** Read-only preflight so a doomed decision never consumes the CAS. */
  private async guardDecision(
    record: ApprovalRecord,
    status: "approved" | "rejected",
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        code: ChangeApprovalErrorCode;
        current: ApprovalRecord | null;
        message: string;
      }
  > {
    if (!record.changeId) {
      return {
        ok: false,
        code: "not_change",
        current: record,
        message: "approval is not linked to a change proposal",
      };
    }
    const proposal = await this.store.proposals.get(record.changeId);
    if (!proposal) {
      return {
        ok: false,
        code: "not_found",
        current: record,
        message: `change proposal ${record.changeId} not found`,
      };
    }
    if (status === "approved") {
      if (proposal.state === "promoted" || proposal.state === "observed") {
        return { ok: true };
      }
      // A blocked proposal resumes by re-evaluating rather than promoting.
      if (proposal.state === "blocked") {
        return { ok: true };
      }
      if (proposal.state !== "evaluated" && proposal.state !== "canary") {
        return {
          ok: false,
          code: "illegal_change",
          current: record,
          message: `proposal is ${proposal.state}, not promotable`,
        };
      }
      try {
        assertPromotionAllowed({
          ...proposal,
          approvalRef: record.approvalId,
        });
      } catch (error) {
        return {
          ok: false,
          code: "illegal_change",
          current: record,
          message:
            error instanceof ChangeGuardError
              ? error.message
              : "proposal failed the promotion guard",
        };
      }
      return { ok: true };
    }
    if (proposal.state === "promoted" || proposal.state === "observed") {
      return {
        ok: false,
        code: "illegal_change",
        current: record,
        message: "change was already promoted and cannot be blocked",
      };
    }
    return { ok: true };
  }

  /** Converges the proposal to the decision; safe to call more than once. */
  private async settle(
    record: ApprovalRecord,
    at: string,
    duplicate: boolean,
  ): Promise<ChangeApprovalDecisionResult> {
    if (!record.changeId) {
      return fail("not_change", record, "approval has no change id");
    }
    const proposal = await this.store.proposals.get(record.changeId);
    if (!proposal) {
      return fail(
        "not_found",
        record,
        `change proposal ${record.changeId} not found`,
      );
    }
    const actor = record.decisionBy ?? "operator";
    const reason = `approval ${record.approvalId} ${record.status}${
      record.decisionReason ? `: ${record.decisionReason}` : ""
    }`;

    if (record.status === "approved") {
      if (proposal.state === "promoted" || proposal.state === "observed") {
        return { ok: true, record, proposal, duplicate };
      }
      if (proposal.state === "blocked") {
        // Resuming a blocked change means re-running evaluation; the apply
        // bridge promotes later once checks pass and the approval is on file.
        await this.store.proposals.setApprovalRef(
          proposal.id,
          record.approvalId,
          at,
        );
        const resumed = await this.store.proposals.transition({
          proposalId: proposal.id,
          trigger: "evaluate",
          actor,
          reason,
          at,
        });
        if (!resumed.ok) {
          return fail(
            "illegal_change",
            record,
            `blocked proposal could not resume: ${resumed.code}`,
          );
        }
        return { ok: true, record, proposal: resumed.proposal, duplicate };
      }
      if (proposal.state !== "evaluated" && proposal.state !== "canary") {
        return fail(
          "illegal_change",
          record,
          `approval granted but proposal is ${proposal.state}, not promotable`,
        );
      }
      const candidate: ChangeProposal = {
        ...proposal,
        approvalRef: record.approvalId,
      };
      try {
        assertPromotionAllowed(candidate);
      } catch (error) {
        return fail(
          "illegal_change",
          record,
          error instanceof ChangeGuardError
            ? error.message
            : "proposal failed the promotion guard",
        );
      }
      await this.store.proposals.setApprovalRef(
        proposal.id,
        record.approvalId,
        at,
      );
      const advanced = await this.store.proposals.transition({
        proposalId: proposal.id,
        trigger: "promote",
        actor,
        reason,
        at,
      });
      if (!advanced.ok) {
        return fail(
          "illegal_change",
          record,
          `proposal could not resume: ${advanced.code}`,
        );
      }
      return { ok: true, record, proposal: advanced.proposal, duplicate };
    }

    if (record.status !== "rejected") {
      return fail(
        "not_pending",
        record,
        `approval is ${record.status}, not a terminal decision`,
      );
    }
    if (
      proposal.state === "blocked" ||
      proposal.state === "failed" ||
      proposal.state === "rolled_back"
    ) {
      return { ok: true, record, proposal, duplicate };
    }
    if (proposal.state === "promoted" || proposal.state === "observed") {
      return fail(
        "illegal_change",
        record,
        "change was already promoted and cannot be blocked",
      );
    }
    const terminated = await this.store.proposals.transition({
      proposalId: proposal.id,
      trigger: "block",
      actor,
      reason,
      at,
    });
    if (!terminated.ok) {
      return fail(
        "illegal_change",
        record,
        `proposal could not terminate: ${terminated.code}`,
      );
    }
    return { ok: true, record, proposal: terminated.proposal, duplicate };
  }

  /** Supplementary activity row; the change transition is the ledger. */
  private async appendAudit(record: ApprovalRecord, at: string): Promise<void> {
    await this.store.sql`
      INSERT INTO activity_events (
        workspace_id, run_id, stage_id, agent_id, kind, status, tool,
        summary, payload, created_at
      ) VALUES (
        ${record.workspaceId}, ${record.runId}, ${record.stageId},
        ${record.decisionBy ?? "operator"}, ${"approval.decided"},
        ${record.status}, ${null},
        ${`change ${record.changeId ?? ""} ${record.status}`},
        ${JSON.stringify({
          approvalId: record.approvalId,
          changeId: record.changeId,
          substrate: record.substrate,
          status: record.status,
          decisionBy: record.decisionBy,
          version: record.version,
        })},
        ${at}
      )
    `.catch(() => undefined);
  }
}

function fail(
  code: ChangeApprovalErrorCode,
  current: ApprovalRecord | null,
  message: string,
): ChangeApprovalDecisionResult {
  return { ok: false, code, current, message };
}

function sameActor(requester: string, decisionBy: string): boolean {
  return requester.trim().toLowerCase() === decisionBy.trim().toLowerCase();
}
