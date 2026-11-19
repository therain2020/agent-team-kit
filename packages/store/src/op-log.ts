import { newId } from "@kit/core";
import type { SqlClient } from "./db";

/**
 * Where a write originated. Kept deliberately small and closed so the op log
 * can be filtered by actor class without free-form strings.
 */
export type OpOrigin =
  | "cli"
  | "web"
  | "agent"
  | "autopilot"
  | "event"
  | "system";

/** Minimal store surface needed to append and read ops. */
export interface OpLogStore {
  sql: SqlClient;
}

export interface OpLogEntry {
  workspaceId?: string;
  entityKind: string;
  entityId: string;
  op: string;
  actor: string;
  origin: OpOrigin;
  /** When present, a second append with the same key returns the first row. */
  idempotencyKey?: string | null;
  payload?: unknown;
  createdAt?: string;
  opId?: string;
}

export interface OpLogRecord {
  seq: number;
  opId: string;
  workspaceId: string;
  entityKind: string;
  entityId: string;
  op: string;
  actor: string;
  origin: OpOrigin;
  idempotencyKey: string | null;
  payload: unknown;
  createdAt: string;
}

export interface ListOpsQuery {
  workspaceId?: string;
  /** Exclusive global cursor: only ops with `seq > after` are returned. */
  after?: number;
  limit?: number;
  entityKind?: string;
  entityId?: string;
}

interface OpLogRow {
  seq: number | string;
  op_id: string;
  workspace_id: string;
  entity_kind: string;
  entity_id: string;
  op: string;
  actor: string;
  origin: string;
  idempotency_key: string | null;
  payload: unknown;
  created_at: string | Date;
}

/**
 * Append one write to the unified op log (20 §3.3/§3.4). `seq` is assigned by
 * the database and is strictly monotonic; it is the cursor used by query and
 * subscription consumers.
 *
 * Idempotency: the unique partial index on `(workspace_id, idempotency_key)`
 * arbitrates `INSERT ... ON CONFLICT DO NOTHING`. When a key collides, this
 * function reads back and returns the first stored row rather than inserting a
 * second time, so callers can safely retry the same logical write. Passing a
 * transaction client (`{ sql: tx }`) keeps the op in the caller's transaction.
 */
export async function appendOp(
  store: OpLogStore,
  entry: OpLogEntry,
): Promise<OpLogRecord> {
  const workspaceId = entry.workspaceId ?? "default";
  const idempotencyKey = normalizeKey(entry.idempotencyKey);
  const createdAt = entry.createdAt ?? new Date().toISOString();
  const payload = JSON.stringify(entry.payload ?? {});

  const inserted = await store.sql<OpLogRow[]>`
    INSERT INTO op_log (
      op_id, workspace_id, entity_kind, entity_id, op, actor, origin,
      idempotency_key, payload, created_at
    ) VALUES (
      ${entry.opId ?? newId("opl")}, ${workspaceId}, ${entry.entityKind},
      ${entry.entityId}, ${entry.op}, ${entry.actor}, ${entry.origin},
      ${idempotencyKey}, ${payload}, ${createdAt}
    ) ON CONFLICT DO NOTHING
    RETURNING *
  `;
  if (inserted[0]) {
    return mapRow(inserted[0]);
  }

  if (idempotencyKey) {
    const existing = await findOpByKey(store, workspaceId, idempotencyKey);
    if (existing) {
      return existing;
    }
  }
  throw new Error("failed to append op log entry");
}

export async function findOpByKey(
  store: OpLogStore,
  workspaceId: string,
  idempotencyKey: string,
): Promise<OpLogRecord | null> {
  const key = normalizeKey(idempotencyKey);
  if (!key) {
    return null;
  }
  const rows = await store.sql<OpLogRow[]>`
    SELECT * FROM op_log
    WHERE workspace_id = ${workspaceId} AND idempotency_key = ${key}
    LIMIT 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Read the log in `seq` order. `after` is the resumable global cursor; the
 * resulting rows always have increasing `seq`, so reconnecting with the last
 * seen value never replays or skips an op.
 */
export async function listOps(
  store: OpLogStore,
  query: ListOpsQuery = {},
): Promise<OpLogRecord[]> {
  const limit = clampInt(query.limit, 1, 1000, 100);
  const after =
    typeof query.after === "number" && Number.isFinite(query.after)
      ? Math.max(0, Math.trunc(query.after))
      : 0;
  const workspaceFilter = query.workspaceId
    ? store.sql`AND workspace_id = ${query.workspaceId}`
    : store.sql``;
  const entityKindFilter = query.entityKind
    ? store.sql`AND entity_kind = ${query.entityKind}`
    : store.sql``;
  const entityIdFilter = query.entityId
    ? store.sql`AND entity_id = ${query.entityId}`
    : store.sql``;

  const rows = await store.sql<OpLogRow[]>`
    SELECT * FROM op_log
    WHERE seq > ${after}
      ${workspaceFilter} ${entityKindFilter} ${entityIdFilter}
    ORDER BY seq ASC
    LIMIT ${limit}
  `;
  return rows.map(mapRow);
}

function mapRow(row: OpLogRow): OpLogRecord {
  return {
    seq: Number(row.seq),
    opId: row.op_id,
    workspaceId: row.workspace_id,
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    op: row.op,
    actor: row.actor,
    origin: row.origin as OpOrigin,
    idempotencyKey: row.idempotency_key,
    payload: parsePayload(row.payload),
    createdAt: toIso(row.created_at),
  };
}

function normalizeKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
