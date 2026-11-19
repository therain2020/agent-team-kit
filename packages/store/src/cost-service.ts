import type { BudgetStore } from "./budget-service";

export interface CostTimeseriesQuery {
  workspaceId: string;
  /** Restrict the series to a single run. */
  runId?: string;
  /** Bucket width in minutes; defaults to 1. Bounds are aligned to UNIX epoch. */
  bucketMinutes?: number;
  /** Inclusive lower bound (defaults to the smallest representable ISO date). */
  since?: Date | string;
  /** Exclusive upper bound (defaults to the largest representable ISO date). */
  until?: Date | string;
}

export interface CostTimeseriesRow {
  /** UTC bucket start, e.g. `2026-11-15T12:00:00Z`. */
  bucket: string;
  runId: string;
  stageId: string | null;
  agentId: string | null;
  cnyMicro: number;
  tokens: number;
}

interface CostTimeseriesDbRow {
  bucket: string;
  run_id: string;
  stage_id: string | null;
  agent_id: string | null;
  cny_micro: number | string;
  tokens: number | string;
}

const MIN_SINCE = "0001-01-01T00:00:00.000Z";
const MAX_UNTIL = "9999-12-31T23:59:59.999Z";
const MAX_BUCKET_MINUTES = 1440;

/**
 * Read-only cost time series over `budget_charges`, grouped by UTC bucket,
 * run, stage and agent. This is the charting read model for the cost river and
 * budget curve; it never writes. The bucket expression is dialect-specific
 * (`to_timestamp`/`extract(epoch)` on Postgres, `strftime` on SQLite) so both
 * drivers return identical ISO bucket labels aligned to the UNIX epoch.
 */
export async function costTimeseries(
  store: BudgetStore,
  query: CostTimeseriesQuery,
): Promise<CostTimeseriesRow[]> {
  const bucketMinutes = normalizeBucketMinutes(query.bucketMinutes);
  const bucketSeconds = bucketMinutes * 60;
  const since = toIsoBound(query.since, MIN_SINCE);
  const until = toIsoBound(query.until, MAX_UNTIL);
  if (since >= until) {
    return [];
  }

  const rows =
    store.driver === "postgres"
      ? await postgresSeries(store, query, bucketSeconds, since, until)
      : await sqliteSeries(store, query, bucketSeconds, since, until);

  return rows.map((row) => ({
    bucket: row.bucket,
    runId: row.run_id,
    stageId: row.stage_id,
    agentId: row.agent_id,
    cnyMicro: Number(row.cny_micro),
    tokens: Number(row.tokens),
  }));
}

async function postgresSeries(
  store: BudgetStore,
  query: CostTimeseriesQuery,
  bucketSeconds: number,
  since: string,
  until: string,
): Promise<CostTimeseriesDbRow[]> {
  if (query.runId) {
    return store.sql<CostTimeseriesDbRow[]>`
      SELECT
        to_char(
          to_timestamp(
            (trunc(extract(epoch FROM created_at) / ${bucketSeconds}) * ${bucketSeconds})::double precision
          ) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ) AS bucket,
        run_id,
        stage_id,
        agent_id,
        SUM(cost_cny_micro) AS cny_micro,
        SUM(tokens) AS tokens
      FROM budget_charges
      WHERE workspace_id = ${query.workspaceId}
        AND run_id = ${query.runId}
        AND created_at >= ${since}
        AND created_at < ${until}
      GROUP BY bucket, run_id, stage_id, agent_id
      ORDER BY bucket, run_id, stage_id, agent_id
    `;
  }
  return store.sql<CostTimeseriesDbRow[]>`
    SELECT
      to_char(
        to_timestamp(
          (trunc(extract(epoch FROM created_at) / ${bucketSeconds}) * ${bucketSeconds})::double precision
        ) AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"'
      ) AS bucket,
      run_id,
      stage_id,
      agent_id,
      SUM(cost_cny_micro) AS cny_micro,
      SUM(tokens) AS tokens
    FROM budget_charges
    WHERE workspace_id = ${query.workspaceId}
      AND created_at >= ${since}
      AND created_at < ${until}
    GROUP BY bucket, run_id, stage_id, agent_id
    ORDER BY bucket, run_id, stage_id, agent_id
  `;
}

async function sqliteSeries(
  store: BudgetStore,
  query: CostTimeseriesQuery,
  bucketSeconds: number,
  since: string,
  until: string,
): Promise<CostTimeseriesDbRow[]> {
  if (query.runId) {
    return store.sql<CostTimeseriesDbRow[]>`
      SELECT
        strftime(
          '%Y-%m-%dT%H:%M:%SZ',
          CAST(CAST(strftime('%s', created_at) AS INTEGER) / ${bucketSeconds} AS INTEGER) * ${bucketSeconds},
          'unixepoch'
        ) AS bucket,
        run_id,
        stage_id,
        agent_id,
        SUM(cost_cny_micro) AS cny_micro,
        SUM(tokens) AS tokens
      FROM budget_charges
      WHERE workspace_id = ${query.workspaceId}
        AND run_id = ${query.runId}
        AND created_at >= ${since}
        AND created_at < ${until}
      GROUP BY bucket, run_id, stage_id, agent_id
      ORDER BY bucket, run_id, stage_id, agent_id
    `;
  }
  return store.sql<CostTimeseriesDbRow[]>`
    SELECT
      strftime(
        '%Y-%m-%dT%H:%M:%SZ',
        CAST(CAST(strftime('%s', created_at) AS INTEGER) / ${bucketSeconds} AS INTEGER) * ${bucketSeconds},
        'unixepoch'
      ) AS bucket,
      run_id,
      stage_id,
      agent_id,
      SUM(cost_cny_micro) AS cny_micro,
      SUM(tokens) AS tokens
    FROM budget_charges
    WHERE workspace_id = ${query.workspaceId}
      AND created_at >= ${since}
      AND created_at < ${until}
    GROUP BY bucket, run_id, stage_id, agent_id
    ORDER BY bucket, run_id, stage_id, agent_id
  `;
}

function normalizeBucketMinutes(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_BUCKET_MINUTES
  ) {
    throw new RangeError(
      `bucketMinutes must be an integer between 1 and ${MAX_BUCKET_MINUTES}`,
    );
  }
  return value;
}

function toIsoBound(
  value: Date | string | undefined,
  fallback: string,
): string {
  if (value === undefined) {
    return fallback;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`invalid time bound: ${String(value)}`);
  }
  return date.toISOString();
}
