import type { SqlClient, StoreDriverName } from "./db";

/**
 * Approvals are a first-class entity: queueing, deciding and expiring are
 * persisted in one table so the inbox is a single indexed query instead of a
 * scan over paused runs and their artifacts.
 *
 * The service talks raw SQL through the shared {@link SqlClient} on purpose:
 * both drivers already translate the same template-literal subset, so one
 * implementation keeps Postgres and SQLite in lockstep without a second pair of
 * Drizzle repositories. Dialect-specific DDL lives in `schema-text.ts`.
 */

export type ApprovalStatus = "queued" | "approved" | "rejected" | "expired";

export type ApprovalKind =
  | "stage_before"
  | "stage_after"
  | "gate_failure"
  | "budget_exceeded";

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "queued",
  "approved",
  "rejected",
  "expired",
];

export interface ApprovalRecord {
  approvalId: string;
  workspaceId: string;
  runId: string;
  stageId: string | null;
  kind: string;
  status: ApprovalStatus;
  requester: string;
  requiredRole: string | null;
  payloadRef: string | null;
  slaDueAt: string | null;
  expiresAt: string | null;
  decisionBy: string | null;
  decisionAt: string | null;
  decisionReason: string | null;
  version: number;
  createdAt: string;
}

/** Approval row enriched with the run/stage columns the inbox renders. */
export interface ApprovalListItem extends ApprovalRecord {
  workflowId: string | null;
  stageName: string | null;
  runStatus: string | null;
}

export interface EnqueueApprovalInput {
  approvalId: string;
  workspaceId: string;
  runId: string;
  stageId?: string | null;
  kind: ApprovalKind | string;
  requester?: string;
  requiredRole?: string | null;
  payloadRef?: string | null;
  slaDueAt?: string | null;
  expiresAt?: string | null;
  createdAt?: string;
}

export interface ApprovalQuery {
  workspaceId?: string;
  status?: ApprovalStatus;
  /** Filter on the joined run status, e.g. `paused` for the legacy inbox. */
  runStatus?: string;
  sort?: "due" | "created";
  cursor?: string | null;
  limit?: number;
}

export interface ApprovalPage {
  items: ApprovalListItem[];
  nextCursor: string | null;
}

export interface ApprovalDecisionInput {
  approvalId: string;
  /** Version read by the caller; the update fails if it changed. */
  expectedVersion: number;
  status: "approved" | "rejected";
  decisionBy: string;
  decisionReason: string;
  at?: string;
}

export type ApprovalDecisionResult =
  | { ok: true; record: ApprovalRecord }
  | {
      ok: false;
      code: "not_found" | "version_conflict" | "not_pending";
      current: ApprovalRecord | null;
    };

interface ApprovalRow {
  approval_id: string;
  workspace_id: string;
  run_id: string;
  stage_id: string | null;
  kind: string;
  status: string;
  requester: string;
  required_role: string | null;
  payload_ref: string | null;
  sla_due_at: string | Date | null;
  expires_at: string | Date | null;
  decision_by: string | null;
  decision_at: string | Date | null;
  decision_reason: string | null;
  version: number | string | bigint;
  created_at: string | Date;
}

interface ApprovalListRow extends ApprovalRow {
  workflow_id: string | null;
  stage_name: string | null;
  run_status: string | null;
}

interface Cursor {
  key: string;
  id: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class ApprovalService {
  constructor(
    private readonly store: {
      sql: SqlClient;
      driver: StoreDriverName;
    },
  ) {}

  /**
   * Inserts the queued approval. Idempotent: re-queueing the same approval id
   * (retries, backfill over a row that already exists) leaves the row intact.
   */
  async enqueue(input: EnqueueApprovalInput): Promise<ApprovalRecord> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    await this.store.sql`
      INSERT INTO approvals (
        approval_id, workspace_id, run_id, stage_id, kind, status, requester,
        required_role, payload_ref, sla_due_at, expires_at, decision_by,
        decision_at, decision_reason, version, created_at
      ) VALUES (
        ${input.approvalId}, ${input.workspaceId}, ${input.runId},
        ${input.stageId ?? null}, ${input.kind}, ${"queued"},
        ${input.requester ?? "manager"}, ${input.requiredRole ?? null},
        ${input.payloadRef ?? null}, ${input.slaDueAt ?? null},
        ${input.expiresAt ?? null}, ${null}, ${null}, ${null}, ${1},
        ${createdAt}
      )
      ON CONFLICT (approval_id) DO NOTHING
    `;
    const record = await this.get(input.approvalId);
    if (!record) {
      throw new Error(`failed to enqueue approval ${input.approvalId}`);
    }
    return record;
  }

  async get(approvalId: string): Promise<ApprovalRecord | null> {
    const rows = await this.store.sql<ApprovalRow[]>`
      SELECT * FROM approvals WHERE approval_id = ${approvalId} LIMIT 1
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Latest approval for a run, optionally narrowed to one status. */
  async getByRun(
    runId: string,
    status?: ApprovalStatus,
  ): Promise<ApprovalRecord | null> {
    const statusFilter = status
      ? this.store.sql`AND status = ${status}`
      : this.store.sql``;
    const rows = await this.store.sql<ApprovalRow[]>`
      SELECT * FROM approvals
      WHERE run_id = ${runId}
        ${statusFilter}
      ORDER BY created_at DESC, approval_id DESC
      LIMIT 1
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Inbox query: one indexed SELECT joining the run and stage names the
   * console renders. `due` sorts by SLA (falling back to expiry/creation);
   * `created` sorts newest first. Cursors are opaque and stable across pages.
   */
  async list(query: ApprovalQuery = {}): Promise<ApprovalPage> {
    const limit = clampInt(query.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
    const sort = query.sort === "created" ? "created" : "due";
    const cursor = decodeCursor(query.cursor);
    const workspaceFilter = query.workspaceId
      ? this.store.sql`AND a.workspace_id = ${query.workspaceId}`
      : this.store.sql``;
    const statusFilter = query.status
      ? this.store.sql`AND a.status = ${query.status}`
      : this.store.sql``;
    const runFilter = query.runStatus
      ? this.store.sql`AND r.status = ${query.runStatus}`
      : this.store.sql``;

    let rows: ApprovalListRow[];
    if (sort === "due") {
      const cursorFilter = cursor
        ? this.store
            .sql`AND (COALESCE(a.sla_due_at, a.expires_at, a.created_at), a.approval_id) > (${cursor.key}, ${cursor.id})`
        : this.store.sql``;
      rows = await this.store.sql<ApprovalListRow[]>`
        SELECT a.*, r.workflow_id AS workflow_id, r.status AS run_status,
               s.name AS stage_name
        FROM approvals a
        LEFT JOIN runs r ON r.run_id = a.run_id
        LEFT JOIN stages s ON s.stage_id = a.stage_id
        WHERE 1 = 1
          ${workspaceFilter}
          ${statusFilter}
          ${runFilter}
          ${cursorFilter}
        ORDER BY COALESCE(a.sla_due_at, a.expires_at, a.created_at) ASC,
                 a.approval_id ASC
        LIMIT ${limit + 1}
      `;
    } else {
      const cursorFilter = cursor
        ? this.store
            .sql`AND (a.created_at, a.approval_id) < (${cursor.key}, ${cursor.id})`
        : this.store.sql``;
      rows = await this.store.sql<ApprovalListRow[]>`
        SELECT a.*, r.workflow_id AS workflow_id, r.status AS run_status,
               s.name AS stage_name
        FROM approvals a
        LEFT JOIN runs r ON r.run_id = a.run_id
        LEFT JOIN stages s ON s.stage_id = a.stage_id
        WHERE 1 = 1
          ${workspaceFilter}
          ${statusFilter}
          ${runFilter}
          ${cursorFilter}
        ORDER BY a.created_at DESC, a.approval_id DESC
        LIMIT ${limit + 1}
      `;
    }

    const pageRows = rows.slice(0, limit).map(mapListRow);
    const hasMore = rows.length > limit;
    const last = pageRows.at(-1);
    return {
      items: pageRows,
      nextCursor:
        hasMore && last
          ? encodeCursor(
              sort === "due"
                ? dueKey(last as ApprovalListItem)
                : last.createdAt,
              last.approvalId,
            )
          : null,
    };
  }

  /**
   * Compare-and-set decision. Only the caller that read the current version
   * wins; everyone else gets `version_conflict` (or `not_pending` when the row
   * already left `queued`, e.g. it expired).
   */
  async decide(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    const at = input.at ?? new Date().toISOString();
    const rows = await this.store.sql<ApprovalRow[]>`
      UPDATE approvals
      SET status = ${input.status},
          decision_by = ${input.decisionBy},
          decision_at = ${at},
          decision_reason = ${input.decisionReason.slice(0, 2000)},
          version = version + 1
      WHERE approval_id = ${input.approvalId}
        AND version = ${input.expectedVersion}
        AND status = 'queued'
      RETURNING *
    `;
    if (rows[0]) {
      return { ok: true, record: mapRow(rows[0]) };
    }

    const current = await this.get(input.approvalId);
    if (!current) {
      return { ok: false, code: "not_found", current: null };
    }
    if (current.version !== input.expectedVersion) {
      return { ok: false, code: "version_conflict", current };
    }
    return { ok: false, code: "not_pending", current };
  }

  /**
   * Moves queued approvals past their expiry to `expired` and writes an
   * activity-event audit row in the same transaction. Re-running is a no-op
   * for rows another tick already expired (version + status CAS).
   */
  async expireDue(now: string, limit = 100): Promise<ApprovalRecord[]> {
    const candidates = await this.store.sql<ApprovalRow[]>`
      SELECT * FROM approvals
      WHERE status = 'queued'
        AND expires_at IS NOT NULL
        AND expires_at <= ${now}
      ORDER BY expires_at ASC, approval_id ASC
      LIMIT ${limit}
    `;

    const expired: ApprovalRecord[] = [];
    for (const candidate of candidates) {
      const record = mapRow(candidate);
      const done = await this.store.sql.begin(async (tx) => {
        const updated = await tx<ApprovalRow[]>`
          UPDATE approvals
          SET status = 'expired',
              decision_by = 'policy:expiry',
              decision_at = ${now},
              decision_reason = 'approval expired without decision',
              version = version + 1
          WHERE approval_id = ${record.approvalId}
            AND version = ${record.version}
            AND status = 'queued'
          RETURNING *
        `;
        if (!updated[0]) {
          return null;
        }
        const row = mapRow(updated[0]);
        const events = await tx<Array<{ event_id: number }>>`
          INSERT INTO activity_events (
            workspace_id, run_id, stage_id, agent_id, kind, status, tool,
            summary, payload, created_at
          ) VALUES (
            ${row.workspaceId}, ${row.runId}, ${row.stageId}, ${"policy"},
            ${"approval.expired"}, ${"expired"}, ${null},
            ${`approval ${row.approvalId} expired without a decision`},
            ${JSON.stringify({
              approvalId: row.approvalId,
              kind: row.kind,
              expiresAt: row.expiresAt,
              version: row.version,
            })},
            ${now}
          )
          RETURNING event_id
        `;
        await tx
          .notify(
            "kit_activity_events",
            JSON.stringify({
              runId: row.runId,
              agentId: "policy",
              kind: "approval.expired",
              eventId: Number(events[0]?.event_id ?? 0),
            }),
          )
          .catch(() => undefined);
        return row;
      });
      if (done) {
        expired.push(done);
      }
    }
    return expired;
  }
}

function mapRow(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.approval_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    stageId: row.stage_id,
    kind: row.kind,
    status: normalizeStatus(row.status),
    requester: row.requester,
    requiredRole: row.required_role,
    payloadRef: row.payload_ref,
    slaDueAt: toIso(row.sla_due_at),
    expiresAt: toIso(row.expires_at),
    decisionBy: row.decision_by,
    decisionAt: toIso(row.decision_at),
    decisionReason: row.decision_reason,
    version: Number(row.version),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function mapListRow(row: ApprovalListRow): ApprovalListItem {
  return {
    ...mapRow(row),
    workflowId: row.workflow_id ?? null,
    stageName: row.stage_name ?? null,
    runStatus: row.run_status ?? null,
  };
}

function normalizeStatus(value: string): ApprovalStatus {
  return value === "approved" ||
    value === "rejected" ||
    value === "expired" ||
    value === "queued"
    ? value
    : "queued";
}

function toIso(value: string | Date | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function dueKey(item: ApprovalRecord): string {
  return item.slaDueAt ?? item.expiresAt ?? item.createdAt;
}

function encodeCursor(key: string, id: string): string {
  return Buffer.from(JSON.stringify([key, id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): Cursor | null {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { key: parsed[0], id: parsed[1] };
    }
  } catch {
    // Malformed cursors restart from the first page instead of failing.
  }
  return null;
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
