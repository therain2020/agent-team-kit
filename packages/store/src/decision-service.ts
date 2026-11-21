import type { SqlClient, StoreDriverName } from "./db";

/**
 * Durable manager decisions. Decisions were artifact-only, which made an
 * auto-approval traceable only by scanning blobs. The table records the same
 * payload plus policy provenance (`policyId`, `scope`, `triggerId`) so every
 * policy decision is queryable by run, request or policy (96 §5.2, 88).
 *
 * Raw SQL through the shared {@link SqlClient} keeps both drivers in lockstep,
 * mirroring {@link ApprovalService}.
 */

export interface DecisionEntry {
  decisionId: string;
  workspaceId: string;
  runId: string;
  requestId: string | null;
  option: string;
  note: string;
  rationale: string | null;
  decidedBy: string;
  policyId: string | null;
  scope: string | null;
  triggerId: string | null;
  batchId: string | null;
  riskClass: string | null;
  createdAt: string;
}

export interface DecisionQuery {
  workspaceId?: string;
  runId?: string;
  policyId?: string;
  limit?: number;
}

interface DecisionRow {
  decision_id: string;
  workspace_id: string;
  run_id: string;
  request_id: string | null;
  option: string;
  note: string;
  rationale: string | null;
  decided_by: string;
  policy_id: string | null;
  scope: string | null;
  trigger_id: string | null;
  batch_id: string | null;
  risk_class: string | null;
  created_at: string | Date;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export class DecisionService {
  constructor(
    private readonly store: {
      sql: SqlClient;
      driver: StoreDriverName;
    },
  ) {}

  /** Idempotent by decision id; a replayed write leaves the row intact. */
  async record(entry: DecisionEntry): Promise<void> {
    await this.store.sql`
      INSERT INTO manager_decisions (
        decision_id, workspace_id, run_id, request_id, option, note, rationale,
        decided_by, policy_id, scope, trigger_id, batch_id, risk_class,
        created_at
      ) VALUES (
        ${entry.decisionId}, ${entry.workspaceId}, ${entry.runId},
        ${entry.requestId}, ${entry.option}, ${entry.note},
        ${entry.rationale}, ${entry.decidedBy}, ${entry.policyId},
        ${entry.scope}, ${entry.triggerId}, ${entry.batchId},
        ${entry.riskClass}, ${entry.createdAt}
      )
      ON CONFLICT (decision_id) DO NOTHING
    `;
  }

  async get(decisionId: string): Promise<DecisionEntry | null> {
    const rows = await this.store.sql<DecisionRow[]>`
      SELECT * FROM manager_decisions
      WHERE decision_id = ${decisionId} LIMIT 1
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Latest decision for an approval request. This is the read path the local
   * engine polls and the duplicate guard for a replayed decision.
   */
  async findByRequest(
    runId: string,
    requestId: string,
  ): Promise<DecisionEntry | null> {
    const rows = await this.store.sql<DecisionRow[]>`
      SELECT * FROM manager_decisions
      WHERE run_id = ${runId} AND request_id = ${requestId}
      ORDER BY created_at DESC, decision_id DESC
      LIMIT 1
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async list(query: DecisionQuery = {}): Promise<DecisionEntry[]> {
    const limit = clampInt(query.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
    const workspaceFilter = query.workspaceId
      ? this.store.sql`AND workspace_id = ${query.workspaceId}`
      : this.store.sql``;
    const runFilter = query.runId
      ? this.store.sql`AND run_id = ${query.runId}`
      : this.store.sql``;
    const policyFilter = query.policyId
      ? this.store.sql`AND policy_id = ${query.policyId}`
      : this.store.sql``;
    const rows = await this.store.sql<DecisionRow[]>`
      SELECT * FROM manager_decisions
      WHERE 1 = 1
        ${workspaceFilter}
        ${runFilter}
        ${policyFilter}
      ORDER BY created_at DESC, decision_id DESC
      LIMIT ${limit}
    `;
    return rows.map(mapRow);
  }
}

function mapRow(row: DecisionRow): DecisionEntry {
  return {
    decisionId: row.decision_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    requestId: row.request_id,
    option: row.option,
    note: row.note,
    rationale: row.rationale,
    decidedBy: row.decided_by,
    policyId: row.policy_id,
    scope: row.scope,
    triggerId: row.trigger_id,
    batchId: row.batch_id,
    riskClass: row.risk_class,
    createdAt: toIso(row.created_at),
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
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
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
