import type { SqlClient } from "./db";

/**
 * 90-day retention for the append-only event logs (plan 95 §9.4,
 * 93-iteration-observability §2.3, D-65/D-67).
 *
 * Only `activity_events` and `iteration_events` are pruned. Runs, stages,
 * artifacts (365-day policy) and the event projection tables are never
 * touched, and the cleanup writes nothing back into the tables it cleans;
 * the caller (CLI / ops job) owns logging the returned report.
 *
 * Deletion is `created_at < cutoff` in fixed-size batches, so it is bounded
 * and idempotent: rows inside the retention window are never eligible, a
 * second call finds nothing left, and a crashed call leaves a smaller batch
 * for the next run. Oldest rows are deleted first, `activity_events` before
 * `iteration_events`.
 */

export const DEFAULT_EVENT_RETENTION_DAYS = 90;
export const DEFAULT_RETENTION_BATCH_SIZE = 1000;
export const DEFAULT_RETENTION_MAX_ROWS = 100_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export const EVENT_RETENTION_TABLES = [
  "activity_events",
  "iteration_events",
] as const;

export type EventRetentionTable = (typeof EVENT_RETENTION_TABLES)[number];

/** Minimal store surface needed by the cleanup; any `initStore()` fits. */
export interface EventRetentionStore {
  sql: SqlClient;
}

export interface EventRetentionOptions {
  /** Retention window in days; rows older than this are pruned. Default 90. */
  retentionDays?: number;
  /** Maximum rows removed per DELETE statement. Default 1000. */
  batchSize?: number;
  /** Maximum rows removed by this call across both tables. Default 100000. */
  maxRowsPerCall?: number;
  /** Report the eligible rows and their time range without deleting. */
  dryRun?: boolean;
  /** Clock override for tests; defaults to `new Date()`. */
  now?: Date | string;
}

export interface EventRetentionTableReport {
  table: EventRetentionTable;
  /** Rows matching `created_at < cutoff` when the table was inspected. */
  eligible: number;
  /** Rows actually deleted (always 0 in dry-run). */
  deleted: number;
  /** Oldest eligible `created_at`, ISO-8601, or null when none exist. */
  oldest: string | null;
  /** Newest eligible `created_at`, ISO-8601, or null when none exist. */
  newest: string | null;
}

export interface EventRetentionReport {
  dryRun: boolean;
  retentionDays: number;
  /** ISO-8601 instant; rows strictly older than this are eligible. */
  cutoff: string;
  tables: EventRetentionTableReport[];
  /** Total eligible rows across both tables. */
  eligible: number;
  /** Total rows deleted across both tables (0 in dry-run). */
  deleted: number;
}

interface ExpiredStatsRow {
  total: number | string;
  oldest: string | Date | null;
  newest: string | Date | null;
}

export async function pruneEventRetention(
  store: EventRetentionStore,
  options: EventRetentionOptions = {},
): Promise<EventRetentionReport> {
  const retentionDays = requirePositiveInteger(
    options.retentionDays ?? DEFAULT_EVENT_RETENTION_DAYS,
    "retentionDays",
  );
  const batchSize = requirePositiveInteger(
    options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE,
    "batchSize",
  );
  const maxRowsPerCall = requirePositiveInteger(
    options.maxRowsPerCall ?? DEFAULT_RETENTION_MAX_ROWS,
    "maxRowsPerCall",
  );
  const now = toDate(options.now ?? new Date());
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
  const dryRun = options.dryRun === true;

  const tables: EventRetentionTableReport[] = [];
  let remaining = maxRowsPerCall;
  for (const table of EVENT_RETENTION_TABLES) {
    const report = await pruneTable(store, table, cutoff, {
      batchSize,
      maxRows: remaining,
      dryRun,
    });
    tables.push(report);
    remaining -= report.deleted;
  }

  return {
    dryRun,
    retentionDays,
    cutoff,
    tables,
    eligible: tables.reduce((sum, table) => sum + table.eligible, 0),
    deleted: tables.reduce((sum, table) => sum + table.deleted, 0),
  };
}

async function pruneTable(
  store: EventRetentionStore,
  table: EventRetentionTable,
  cutoff: string,
  options: { batchSize: number; maxRows: number; dryRun: boolean },
): Promise<EventRetentionTableReport> {
  const before = await expiredStats(store, table, cutoff);
  const report: EventRetentionTableReport = {
    table,
    eligible: before.total,
    deleted: 0,
    oldest: toIsoOrNull(before.oldest),
    newest: toIsoOrNull(before.newest),
  };
  if (options.dryRun || options.maxRows <= 0 || before.total === 0) {
    return report;
  }

  let remaining = Math.min(before.total, options.maxRows);
  while (remaining > 0) {
    const limit = Math.min(options.batchSize, remaining);
    await deleteExpiredBatch(store, table, cutoff, limit);
    remaining -= limit;
  }

  // A concurrent writer can only add rows; anything still older than the
  // cutoff after the batches is left for the next call.
  const after = await expiredStats(store, table, cutoff);
  report.deleted = Math.max(0, before.total - after.total);
  return report;
}

async function expiredStats(
  store: EventRetentionStore,
  table: EventRetentionTable,
  cutoff: string,
): Promise<ExpiredStatsRow> {
  const rows =
    table === "activity_events"
      ? await store.sql<ExpiredStatsRow[]>`
          SELECT
            COUNT(*) AS total,
            MIN(created_at) AS oldest,
            MAX(created_at) AS newest
          FROM activity_events
          WHERE created_at < ${cutoff}
        `
      : await store.sql<ExpiredStatsRow[]>`
          SELECT
            COUNT(*) AS total,
            MIN(created_at) AS oldest,
            MAX(created_at) AS newest
          FROM iteration_events
          WHERE created_at < ${cutoff}
        `;
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    oldest: row?.oldest ?? null,
    newest: row?.newest ?? null,
  };
}

async function deleteExpiredBatch(
  store: EventRetentionStore,
  table: EventRetentionTable,
  cutoff: string,
  limit: number,
): Promise<void> {
  // The table name is a fixed literal (never user input); cutoff and limit
  // stay parameterized for both drivers.
  if (table === "activity_events") {
    await store.sql`
      DELETE FROM activity_events
      WHERE event_id IN (
        SELECT event_id FROM activity_events
        WHERE created_at < ${cutoff}
        ORDER BY created_at ASC, event_id ASC
        LIMIT ${limit}
      )
    `;
    return;
  }
  await store.sql`
    DELETE FROM iteration_events
    WHERE event_id IN (
      SELECT event_id FROM iteration_events
      WHERE created_at < ${cutoff}
      ORDER BY created_at ASC, event_id ASC
      LIMIT ${limit}
    )
  `;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`invalid now: ${String(value)}`);
  }
  return date;
}

function toIsoOrNull(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
