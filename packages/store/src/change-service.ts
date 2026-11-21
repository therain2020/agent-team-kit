import { createHash } from "node:crypto";
import {
  type Blob,
  type ChangeProducer,
  type ChangeProposal,
  type ChangeState,
  type ChangeTransition,
  ChangeTransitionError,
  type ChangeTrigger,
  applyChangeTransition,
  changeProposalSchema,
  newId,
} from "@kit/core";
import type { BlobClient } from "./blob";
import type { SqlClient, StoreDriverName } from "./db";
import type { BlobRepository } from "./repositories";

/**
 * Durable home for `ChangeProposal` rows and their append-only transition
 * audit (85 §2, §3.5; D-52).
 *
 * Like `ApprovalService`, this talks raw SQL through the shared `SqlClient` so
 * Postgres and SQLite stay in lockstep with one implementation; the DDL lives
 * in `schema-text.ts`. The row is the source of truth. Large payloads (diffs,
 * rendered proposal documents) are written content-addressed to blob storage
 * and referenced from `content_ref` — never inlined into the row.
 *
 * The service never applies or promotes anything itself. It only records
 * proposals and validates state transitions; the 86 single-writer queue stays
 * the only write path to the workspace.
 */

export interface ChangeProposalServiceDeps {
  sql: SqlClient;
  driver: StoreDriverName;
  blobs?: BlobRepository;
  blobClient?: BlobClient;
}

export interface CreateChangeProposalOptions {
  /**
   * Optional payload stored content-addressed in blob storage. The proposal
   * row keeps only the resulting blob id (D-52).
   */
  content?: Uint8Array;
}

export interface ChangeProposalQuery {
  workspaceId?: string;
  state?: ChangeState;
  producer?: ChangeProducer;
  limit?: number;
}

export interface TransitionChangeProposalInput {
  proposalId: string;
  trigger: ChangeTrigger;
  actor: string;
  reason?: string;
  at?: string;
  /** Version read by the caller; omit to transition from the latest row. */
  expectedVersion?: number;
}

export type TransitionChangeProposalResult =
  | { ok: true; proposal: ChangeProposal; transition: ChangeTransition }
  | {
      ok: false;
      code:
        | "not_found"
        | "version_conflict"
        | "illegal_transition"
        | "stale_transition";
      current: ChangeProposal | null;
    };

interface ChangeProposalRow {
  proposal_id: string;
  workspace_id: string;
  substrate: string;
  producer: string;
  state: string;
  risk: string;
  hypothesis: string;
  acceptance: unknown;
  signal_refs: unknown;
  eval_plan: unknown;
  source_ref: unknown;
  revert_ref: string | null;
  budget_ref: string | null;
  approval_ref: string | null;
  outcome: unknown;
  content_ref: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  version: number | string | bigint;
}

interface ChangeTransitionRow {
  audit_id: string;
  proposal_id: string;
  from_state: string | null;
  to_state: string;
  trigger: string;
  actor: string;
  reason: string;
  at: string | Date;
  sequence: number | string | bigint;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export class ChangeProposalService {
  constructor(private readonly store: ChangeProposalServiceDeps) {}

  /**
   * Inserts the proposal and its existing audit rows. Idempotent: replaying the
   * same proposal (shadow adapter retries, backfill) leaves the row intact.
   */
  async create(
    proposal: ChangeProposal,
    options: CreateChangeProposalOptions = {},
  ): Promise<ChangeProposal> {
    const parsed = changeProposalSchema.parse(proposal);
    // Replaying a deterministic id (shadow adapter retries) is a no-op; the
    // existing row and its audit trail are authoritative.
    const existing = await this.get(parsed.id);
    if (existing) {
      return existing;
    }
    const contentRef = options.content
      ? (await this.putContent(parsed.workspaceId, options.content)).blobId
      : parsed.contentRef;

    await this.store.sql`
      INSERT INTO change_proposals (
        proposal_id, workspace_id, substrate, producer, state, risk,
        hypothesis, acceptance, signal_refs, eval_plan, source_ref,
        revert_ref, budget_ref, approval_ref, outcome, content_ref,
        created_at, updated_at, version
      ) VALUES (
        ${parsed.id}, ${parsed.workspaceId}, ${parsed.substrate},
        ${parsed.producer}, ${parsed.state}, ${parsed.risk},
        ${parsed.hypothesis}, ${this.store.sql.json(parsed.acceptance)},
        ${this.store.sql.json(parsed.signalRefs)},
        ${this.store.sql.json(parsed.evalPlan)},
        ${parsed.sourceRef === null ? null : this.store.sql.json(parsed.sourceRef)},
        ${parsed.revertRef}, ${parsed.budgetRef}, ${parsed.approvalRef},
        ${parsed.outcome === null ? null : this.store.sql.json(parsed.outcome)},
        ${contentRef}, ${parsed.createdAt}, ${parsed.updatedAt},
        ${parsed.version}
      )
      ON CONFLICT (proposal_id) DO NOTHING
    `;

    for (const [index, transition] of parsed.history.entries()) {
      await this.insertTransition(parsed.id, transition, index + 1);
    }

    const stored = await this.get(parsed.id);
    if (!stored) {
      throw new Error(`failed to persist change proposal ${parsed.id}`);
    }
    return stored;
  }

  async get(proposalId: string): Promise<ChangeProposal | null> {
    const rows = await this.store.sql<ChangeProposalRow[]>`
      SELECT * FROM change_proposals
      WHERE proposal_id = ${proposalId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }
    const history = await this.listTransitions(proposalId);
    return mapProposalRow(row, history);
  }

  /** Newest first. History is omitted; call {@link get} for the full record. */
  async list(query: ChangeProposalQuery = {}): Promise<ChangeProposal[]> {
    const limit = clampInt(query.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
    const workspaceFilter = query.workspaceId
      ? this.store.sql`AND workspace_id = ${query.workspaceId}`
      : this.store.sql``;
    const stateFilter = query.state
      ? this.store.sql`AND state = ${query.state}`
      : this.store.sql``;
    const producerFilter = query.producer
      ? this.store.sql`AND producer = ${query.producer}`
      : this.store.sql``;
    const rows = await this.store.sql<ChangeProposalRow[]>`
      SELECT * FROM change_proposals
      WHERE 1 = 1
        ${workspaceFilter}
        ${stateFilter}
        ${producerFilter}
      ORDER BY created_at DESC, proposal_id DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => mapProposalRow(row, []));
  }

  async listTransitions(proposalId: string): Promise<ChangeTransition[]> {
    const rows = await this.store.sql<ChangeTransitionRow[]>`
      SELECT * FROM change_proposal_transitions
      WHERE proposal_id = ${proposalId}
      ORDER BY sequence ASC
    `;
    return rows.map(mapTransitionRow);
  }

  /**
   * Compare-and-set transition. The state machine from `@kit/core` decides
   * legality; this method persists the state change and appends the audit row
   * in one transaction. A concurrent writer loses with `version_conflict`
   * instead of interleaving two audit trails.
   */
  async transition(
    input: TransitionChangeProposalInput,
  ): Promise<TransitionChangeProposalResult> {
    const current = await this.get(input.proposalId);
    if (!current) {
      return { ok: false, code: "not_found", current: null };
    }
    if (
      input.expectedVersion !== undefined &&
      current.version !== input.expectedVersion
    ) {
      return { ok: false, code: "version_conflict", current };
    }

    let next: ChangeProposal;
    try {
      next = applyChangeTransition(current, {
        trigger: input.trigger,
        actor: input.actor,
        reason: input.reason ?? "",
        ...(input.at ? { at: input.at } : {}),
      });
    } catch (error) {
      if (error instanceof ChangeTransitionError) {
        return { ok: false, code: "illegal_transition", current };
      }
      throw error;
    }
    const transition = next.history.at(-1);
    if (!transition) {
      return { ok: false, code: "stale_transition", current };
    }

    const saved = await this.store.sql.begin(async (tx) => {
      const updated = await tx<ChangeProposalRow[]>`
        UPDATE change_proposals
        SET state = ${next.state},
            outcome = ${
              next.outcome === null ? null : this.store.sql.json(next.outcome)
            },
            updated_at = ${next.updatedAt},
            version = version + 1
        WHERE proposal_id = ${input.proposalId}
          AND version = ${current.version}
        RETURNING *
      `;
      const row = updated[0];
      if (!row) {
        return null;
      }
      const sequence = await nextTransitionSequence(tx, input.proposalId);
      await tx`
        INSERT INTO change_proposal_transitions (
          audit_id, proposal_id, from_state, to_state, trigger, actor,
          reason, at, sequence
        ) VALUES (
          ${transition.auditId}, ${input.proposalId}, ${transition.from},
          ${transition.to}, ${transition.trigger}, ${transition.actor},
          ${transition.reason}, ${transition.at}, ${sequence}
        )
      `;
      return row;
    });

    if (!saved) {
      const latest = await this.get(input.proposalId);
      return { ok: false, code: "version_conflict", current: latest };
    }
    const history = await this.listTransitions(input.proposalId);
    return {
      ok: true,
      proposal: mapProposalRow(saved, history),
      transition,
    };
  }

  /**
   * Links the approval that cleared a high-risk proposal. Idempotent and
   * deliberately does not bump `version`: linking an approval is evidence, not
   * a state transition, so a retried decision cannot invalidate a concurrent
   * transition's CAS.
   */
  async setApprovalRef(
    proposalId: string,
    approvalRef: string,
    at?: string,
  ): Promise<ChangeProposal | null> {
    const now = at ?? new Date().toISOString();
    await this.store.sql`
      UPDATE change_proposals
      SET approval_ref = ${approvalRef},
          updated_at = ${now}
      WHERE proposal_id = ${proposalId}
        AND (approval_ref IS NULL OR approval_ref = ${approvalRef})
    `;
    return await this.get(proposalId);
  }

  /** Reads a proposal payload previously stored via {@link create}. */
  async readContent(proposalId: string): Promise<Uint8Array | null> {
    const proposal = await this.get(proposalId);
    if (!proposal?.contentRef) {
      return null;
    }
    const blob = await this.store.blobs?.findById(proposal.contentRef);
    if (!blob || !this.store.blobClient) {
      return null;
    }
    return await this.store.blobClient.get(blob.storageKey);
  }

  private async insertTransition(
    proposalId: string,
    transition: ChangeTransition,
    sequence: number,
  ): Promise<void> {
    await this.store.sql`
      INSERT INTO change_proposal_transitions (
        audit_id, proposal_id, from_state, to_state, trigger, actor,
        reason, at, sequence
      ) VALUES (
        ${transition.auditId}, ${proposalId}, ${transition.from},
        ${transition.to}, ${transition.trigger}, ${transition.actor},
        ${transition.reason}, ${transition.at}, ${sequence}
      )
      ON CONFLICT (audit_id) DO NOTHING
    `;
  }

  private async putContent(
    workspaceId: string,
    content: Uint8Array,
  ): Promise<Blob> {
    const { blobs, blobClient } = this.store;
    if (!blobs || !blobClient) {
      throw new Error(
        "change proposal content storage requires the blob repository and client",
      );
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    const storageKey = `change/${workspaceId}/${sha256}`;
    await blobClient.put(storageKey, content);

    const existing = await blobs.find(workspaceId, sha256);
    if (existing) {
      return existing;
    }
    const candidate: Blob = {
      blobId: newId("blb"),
      workspaceId,
      sha256,
      size: content.byteLength,
      storageKey,
      createdAt: new Date().toISOString(),
    };
    // Content addressing makes a concurrent insert of the same blob harmless.
    await blobs.insert(candidate).catch(() => false);
    return (await blobs.find(workspaceId, sha256)) ?? candidate;
  }
}

async function nextTransitionSequence(
  tx: SqlClient,
  proposalId: string,
): Promise<number> {
  const rows = await tx<Array<{ next_sequence: number | string | bigint }>>`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
    FROM change_proposal_transitions
    WHERE proposal_id = ${proposalId}
  `;
  return Number(rows[0]?.next_sequence ?? 1);
}

function mapProposalRow(
  row: ChangeProposalRow,
  history: ChangeTransition[],
): ChangeProposal {
  return changeProposalSchema.parse({
    id: row.proposal_id,
    workspaceId: row.workspace_id,
    substrate: row.substrate,
    producer: row.producer,
    state: row.state,
    risk: row.risk,
    hypothesis: row.hypothesis,
    acceptance: parseJson<unknown[]>(row.acceptance, []),
    signalRefs: parseJson<unknown[]>(row.signal_refs, []),
    evalPlan: parseJson<Record<string, unknown>>(row.eval_plan, {
      checks: [],
      evalRefs: [],
      snapshotRef: null,
    }),
    sourceRef: parseJson<unknown>(row.source_ref, null),
    revertRef: row.revert_ref,
    budgetRef: row.budget_ref,
    approvalRef: row.approval_ref,
    outcome: parseJson<unknown>(row.outcome, null),
    contentRef: row.content_ref,
    history,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: Number(row.version),
  });
}

function mapTransitionRow(row: ChangeTransitionRow): ChangeTransition {
  return {
    auditId: row.audit_id,
    from: row.from_state === null ? null : (row.from_state as ChangeState),
    to: row.to_state as ChangeState,
    trigger: row.trigger as ChangeTrigger,
    actor: row.actor,
    reason: row.reason,
    at: toIso(row.at),
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
