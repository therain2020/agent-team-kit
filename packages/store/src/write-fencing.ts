import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { type OpLogStore, appendOp } from "./op-log";

/**
 * A worker's claim on a `run_requests` row (61 §3.5, 20 §3.4).
 *
 * `leaseVersion` is the fencing token: it is incremented every time the row is
 * claimed, so a worker whose heartbeat expired can no longer write downstream
 * rows once another worker re-claims the request.
 */
export interface WriteLease {
  requestId: string;
  owner: string;
  leaseVersion: number;
}

/** Optional guards for a write to `runs`/`stages`. */
export interface WriteOptions {
  /** Fence the write against the claim record; 0 rows when the lease moved on. */
  lease?: WriteLease | null;
  /** Optimistic CAS on the row's `version` column. */
  expectedVersion?: number;
}

export type WriteConflictReason =
  | "lease_fenced"
  | "lease_mismatch"
  | "version_mismatch";

export type WriteEntityKind = "run" | "stage" | "run_request";

export interface WriteConflictDetail {
  entityKind: WriteEntityKind;
  entityId: string;
  reason: WriteConflictReason;
  expectedVersion?: number;
  leaseVersion?: number;
  owner?: string;
  requestId?: string;
  /** Row version at rejection time, when it could be read. */
  currentVersion?: number | null;
}

/**
 * A write was rejected because the caller's lease or expected version no
 * longer matches. The `conflict` code maps onto the machine-readable CLI
 * contract (91 §3.6) and callers may retry after re-reading the row.
 */
export class VersionConflictError extends Error {
  readonly code = "conflict" as const;
  readonly retryable = true;
  readonly detail: WriteConflictDetail;

  constructor(detail: WriteConflictDetail, message?: string) {
    super(
      message ??
        `${detail.entityKind} ${detail.entityId} write rejected: ${detail.reason}`,
    );
    this.name = "VersionConflictError";
    this.detail = detail;
  }
}

export function isVersionConflictError(
  value: unknown,
): value is VersionConflictError {
  return value instanceof VersionConflictError;
}

export function conflictOp(detail: WriteConflictDetail): string {
  return `${detail.entityKind}.conflict`;
}

/**
 * True when a claim record still matches the given lease. Used as an extra
 * `WHERE` predicate so stale workers update 0 rows instead of overwriting the
 * new owner's progress.
 */
export function leaseClaimExists(
  runIdColumn: SQLWrapper,
  lease: WriteLease,
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM run_requests
    WHERE run_requests.run_id = ${runIdColumn}
      AND run_requests.request_id = ${lease.requestId}
      AND run_requests.claimed_by = ${lease.owner}
      AND run_requests.lease_version = ${lease.leaseVersion}
      AND run_requests.status = 'claimed'
  )`;
}

/**
 * Best-effort audit of a rejected fenced/CAS write. Audit failures must never
 * mask the conflict itself, so they are swallowed after logging.
 */
export async function recordWriteConflict(
  opLog: OpLogStore | null | undefined,
  detail: WriteConflictDetail,
  options: { workspaceId?: string | null; actor?: string } = {},
): Promise<void> {
  if (!opLog) {
    return;
  }
  try {
    await appendOp(opLog, {
      workspaceId: options.workspaceId ?? "default",
      entityKind: detail.entityKind,
      entityId: detail.entityId,
      op: conflictOp(detail),
      actor: options.actor ?? "store",
      origin: "system",
      payload: { ...detail, at: new Date().toISOString() },
    });
  } catch (error) {
    console.error(
      `[store] failed to audit ${detail.entityKind} conflict: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Reason for a rejection given the guards the caller supplied. */
export function conflictReason(
  entityKind: WriteEntityKind,
  options: WriteOptions,
): WriteConflictReason {
  if (entityKind === "run_request") {
    return "lease_mismatch";
  }
  return options.lease ? "lease_fenced" : "version_mismatch";
}

export function conflictDetail(
  entityKind: WriteEntityKind,
  entityId: string,
  options: WriteOptions,
  currentVersion: number | null,
): WriteConflictDetail {
  return {
    entityKind,
    entityId,
    reason: conflictReason(entityKind, options),
    ...(options.expectedVersion !== undefined
      ? { expectedVersion: options.expectedVersion }
      : {}),
    ...(options.lease
      ? {
          leaseVersion: options.lease.leaseVersion,
          owner: options.lease.owner,
          requestId: options.lease.requestId,
        }
      : {}),
    currentVersion,
  };
}
