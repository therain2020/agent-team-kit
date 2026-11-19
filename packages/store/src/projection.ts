import type { SqlClient } from "./db";

/**
 * Run world projection (87 §4.4).
 *
 * `run_projection` is a one-row-per-run materialized read model used by the
 * console world snapshot. It is written through a single choke point,
 * `projectActivityEvent`, which is invoked from `appendActivity` inside the
 * same transaction as the activity insert. Keeping the write path in one place
 * makes rebases against other write-path work (op_log) cheap and keeps the
 * projection exactly as fresh as the activity log it derives from.
 *
 * Idempotency and ordering:
 * - Aggregates (progress, cost, tokens, artifact count) are recomputed from the
 *   source tables, never incremented, so replaying the same event is a no-op.
 * - Ordering-sensitive fields (status, current stage, wait reason) only advance
 *   for events whose id is not older than the last applied event.
 */

export interface ProjectableActivityEvent {
  eventId: number;
  workspaceId: string;
  runId?: string | null;
  stageId?: string | null;
  agentId?: string | null;
  kind: string;
  status?: string | null;
  tool?: string | null;
  summary?: string | null;
  createdAt: string;
}

export interface RunProjection {
  runId: string;
  workspaceId: string;
  status: string;
  currentStage: string | null;
  progress: number;
  costCny: number;
  tokens: number;
  artifactCount: number;
  waitReason: string | null;
  lastEventId: number;
  version: number;
  updatedAt: string;
}

export interface AgentState {
  agentId: string;
  state: string;
  since: string;
  runId: string | null;
  currentTool: string | null;
}

export interface ProjectionStore {
  sql: SqlClient;
}

export interface RunProjectionQuery {
  workspaceId: string;
  /** Only rows materialized after this activity cursor (exclusive). */
  since?: number;
  limit?: number;
  /** Restrict to the given run ids (used by the streaming delta). */
  runIds?: readonly string[];
}

export interface AgentStateQuery {
  workspaceId: string;
  limit?: number;
}

interface RunProjectionRow {
  run_id: string;
  workspace_id: string;
  status: string;
  current_stage: string | null;
  progress: number | string;
  cost_cny: number | string;
  tokens: number | string;
  artifact_count: number | string;
  wait_reason: string | null;
  last_event_id: number | string;
  version: number | string;
  updated_at: string | Date;
}

const TERMINAL_KINDS = new Set([
  "run.finished",
  "run.failed",
  "run.cancelled",
  "iteration.run.finished",
  "iteration.run.failed",
]);

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

export interface StatusTransition {
  /** A run status to apply; absent means "keep the previous status". */
  status?: string;
  /** `undefined` keeps the previous wait reason, `null` clears it. */
  waitReason?: string | null;
}

/**
 * Maps an activity event onto ordering-sensitive run projection fields.
 * Only run-level events change status; stage/tool chatter leaves it alone.
 */
export function deriveStatusTransition(
  event: ProjectableActivityEvent,
  previousStatus: string | null,
): StatusTransition {
  const status = (event.status ?? "").toLowerCase();
  const previous = previousStatus?.toLowerCase() ?? null;

  if (event.kind === "budget.exceeded" || status === "paused") {
    return { status: "paused", waitReason: event.summary ?? "paused" };
  }
  if (
    event.kind === "approval.requested" &&
    (status === "pending" || status === "")
  ) {
    return { status: "paused", waitReason: event.summary ?? null };
  }
  if (event.kind === "approval.decided") {
    if (status === "approve" || status === "approved" || status === "resume") {
      return { status: "running", waitReason: null };
    }
    if (status === "abort" || status === "reject" || status === "aborted") {
      return { status: "cancelled", waitReason: null };
    }
    return {};
  }
  if (TERMINAL_KINDS.has(event.kind)) {
    const mapped = mapTerminalStatus(status);
    return mapped ? { status: mapped, waitReason: null } : {};
  }
  if (status === "running") {
    return {
      status: "running",
      ...(previous === "paused" ? { waitReason: null } : {}),
    };
  }
  return {};
}

function mapTerminalStatus(status: string): string | null {
  switch (status) {
    case "succeeded":
    case "completed":
    case "passed":
    case "partial":
      return "succeeded";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * The single choke point for projection writes. Called from `appendActivity`
 * inside its transaction; can also be replayed directly (tests, repairs).
 */
export async function projectActivityEvent(
  sql: SqlClient,
  event: ProjectableActivityEvent,
): Promise<RunProjection | null> {
  const runId = event.runId ?? null;
  if (!runId) {
    return null;
  }

  const existing = await sql<RunProjectionRow[]>`
    SELECT * FROM run_projection WHERE run_id = ${runId} LIMIT 1
  `;
  const previous = existing[0] ? mapRunProjection(existing[0]) : null;

  // Out-of-order delivery: a newer event already materialized this run. The
  // aggregates from the stale event would be no fresher than what is stored.
  if (previous && event.eventId < previous.lastEventId) {
    return previous;
  }

  const transition = deriveStatusTransition(event, previous?.status ?? null);
  const status = transition.status ?? previous?.status ?? "pending";
  const waitReason =
    transition.waitReason === undefined
      ? (previous?.waitReason ?? null)
      : transition.waitReason;
  const currentStage = event.stageId ?? previous?.currentStage ?? null;
  const totals = await readRunTotals(sql, runId, status);

  const rows = await sql<RunProjectionRow[]>`
    INSERT INTO run_projection (
      run_id, workspace_id, status, current_stage, progress, cost_cny, tokens,
      artifact_count, wait_reason, last_event_id, version, updated_at
    ) VALUES (
      ${runId}, ${event.workspaceId}, ${status}, ${currentStage},
      ${totals.progress}, ${totals.costCny}, ${totals.tokens},
      ${totals.artifactCount}, ${waitReason}, ${event.eventId}, 1,
      ${event.createdAt}
    )
    ON CONFLICT (run_id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      status = EXCLUDED.status,
      current_stage = EXCLUDED.current_stage,
      progress = EXCLUDED.progress,
      cost_cny = EXCLUDED.cost_cny,
      tokens = EXCLUDED.tokens,
      artifact_count = EXCLUDED.artifact_count,
      wait_reason = EXCLUDED.wait_reason,
      last_event_id = EXCLUDED.last_event_id,
      version = run_projection.version + 1,
      updated_at = EXCLUDED.updated_at
    WHERE EXCLUDED.last_event_id >= run_projection.last_event_id
    RETURNING *
  `;
  return rows[0] ? mapRunProjection(rows[0]) : previous;
}

interface RunTotals {
  progress: number;
  costCny: number;
  tokens: number;
  artifactCount: number;
}

async function readRunTotals(
  sql: SqlClient,
  runId: string,
  status: string,
): Promise<RunTotals> {
  const stageDone = sql`status IN ('succeeded', 'failed', 'skipped')`;
  const stageRows = await sql<
    Array<{ total: number | string; done: number | string }>
  >`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN ${stageDone} THEN 1 ELSE 0 END), 0) AS done
    FROM stages
    WHERE run_id = ${runId}
  `;
  let total = Number(stageRows[0]?.total ?? 0);
  let done = Number(stageRows[0]?.done ?? 0);

  // Iteration runs are not in `stages`; fall back to their task ledger.
  if (total === 0) {
    const taskDone = sql`status IN ('passed', 'failed', 'skipped', 'blocked', 'reverted', 'applied')`;
    const taskRows = await sql<
      Array<{ total: number | string; done: number | string }>
    >`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN ${taskDone} THEN 1 ELSE 0 END), 0) AS done
      FROM iteration_tasks
      WHERE iteration_id = ${runId}
    `;
    total = Number(taskRows[0]?.total ?? 0);
    done = Number(taskRows[0]?.done ?? 0);
  }

  const costRows = await sql<
    Array<{ cny_micro: number | string; tokens: number | string }>
  >`
    SELECT
      COALESCE(SUM(cost_cny_micro), 0) AS cny_micro,
      COALESCE(SUM(tokens), 0) AS tokens
    FROM budget_charges
    WHERE run_id = ${runId}
  `;
  const artifactRows = await sql<Array<{ count: number | string }>>`
    SELECT COUNT(*) AS count
    FROM artifacts a
    JOIN manifests m ON m.manifest_id = a.manifest_id
    WHERE m.run_id = ${runId}
  `;

  const progress =
    total > 0
      ? clampProgress(done / total)
      : TERMINAL_STATUSES.has(status)
        ? 1
        : 0;

  return {
    progress,
    costCny: Number(costRows[0]?.cny_micro ?? 0) / 1_000_000,
    tokens: Number(costRows[0]?.tokens ?? 0),
    artifactCount: Number(artifactRows[0]?.count ?? 0),
  };
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export async function loadRunProjections(
  sql: SqlClient,
  query: RunProjectionQuery,
): Promise<RunProjection[]> {
  const limit = clampLimit(query.limit);
  const sinceFilter =
    query.since !== undefined ? sql`AND last_event_id > ${query.since}` : sql``;
  const runFilter = buildRunIdFilter(sql, query.runIds ?? []);

  const rows = await sql<RunProjectionRow[]>`
    SELECT * FROM run_projection
    WHERE workspace_id = ${query.workspaceId}
      ${sinceFilter} ${runFilter}
    ORDER BY updated_at DESC, run_id ASC
    LIMIT ${limit}
  `;
  return rows.map(mapRunProjection);
}

export async function getRunProjection(
  sql: SqlClient,
  runId: string,
): Promise<RunProjection | null> {
  const rows = await sql<RunProjectionRow[]>`
    SELECT * FROM run_projection WHERE run_id = ${runId} LIMIT 1
  `;
  return rows[0] ? mapRunProjection(rows[0]) : null;
}

interface AgentStateRow {
  seq: number | string;
  agent_id: string | null;
  status: string | null;
  kind: string | null;
  run_id: string | null;
  tool: string | null;
  created_at: string | Date | null;
}

export interface AgentStateSnapshot {
  agents: AgentState[];
  /** `MAX(activity_events.event_id)` read in the same statement. */
  seq: number;
}

/**
 * Derived agent state (no write path): the latest activity event per agent
 * yields `state`, `since`, `run_id` and the tool currently being used. The
 * statement also carries the activity cursor (`seq`) so the world snapshot
 * needs only two queries: this one and the run projection SELECT.
 */
export async function loadAgentStateSnapshot(
  sql: SqlClient,
  query: AgentStateQuery,
): Promise<AgentStateSnapshot> {
  const limit = clampLimit(query.limit);
  const rows = await sql<AgentStateRow[]>`
    SELECT
      s.seq,
      a.agent_id, a.status, a.kind, a.run_id, a.tool, a.created_at
    FROM (SELECT COALESCE(MAX(event_id), 0) AS seq FROM activity_events) s
    LEFT JOIN (
      SELECT
        a.agent_id, a.status, a.kind, a.run_id, a.tool, a.created_at
      FROM activity_events a
      JOIN (
        SELECT agent_id, MAX(event_id) AS max_event_id
        FROM activity_events
        WHERE agent_id IS NOT NULL AND workspace_id = ${query.workspaceId}
        GROUP BY agent_id
      ) latest
        ON latest.agent_id = a.agent_id
        AND latest.max_event_id = a.event_id
      WHERE a.workspace_id = ${query.workspaceId}
      ORDER BY a.created_at DESC, a.agent_id ASC
      LIMIT ${limit}
    ) a ON 1 = 1
    ORDER BY (a.created_at IS NULL), a.created_at DESC, a.agent_id ASC
  `;

  const agents: AgentState[] = [];
  for (const row of rows) {
    if (!row.agent_id) {
      continue;
    }
    agents.push({
      agentId: row.agent_id,
      state: row.status ?? row.kind ?? "unknown",
      since: row.created_at ? toIso(row.created_at) : "",
      runId: row.run_id,
      currentTool: row.tool,
    });
  }
  return { agents, seq: Number(rows[0]?.seq ?? 0) };
}

export async function listAgentStates(
  sql: SqlClient,
  query: AgentStateQuery,
): Promise<AgentState[]> {
  const snapshot = await loadAgentStateSnapshot(sql, query);
  return snapshot.agents;
}

/** Derives an agent state snapshot from an activity event (stream deltas). */
export function agentStateFromEvent(
  event: ProjectableActivityEvent,
): AgentState | null {
  if (!event.agentId) {
    return null;
  }
  return {
    agentId: event.agentId,
    state: event.status ?? event.kind,
    since: event.createdAt,
    runId: event.runId ?? null,
    currentTool: event.tool ?? null,
  };
}

interface BackfillRunRow {
  run_id: string;
  workspace_id: string;
  status: string;
  phase?: string | null;
  updated_at: string | Date;
}

export interface BackfillResult {
  runs: number;
}

/**
 * Materializes `run_projection` from the existing `runs` / `iteration_runs` /
 * `stages` / `iteration_tasks` / `manifests` / `budget_charges` rows so installs
 * created before the projection existed work immediately. Idempotent: re-runs
 * converge to the same logical state and only bump `version`.
 */
export async function backfillRunProjections(
  store: ProjectionStore,
  options: { workspaceId?: string } = {},
): Promise<BackfillResult> {
  const sql = store.sql;
  const runScope = options.workspaceId
    ? sql`WHERE workspace_id = ${options.workspaceId}`
    : sql``;

  const runs = await sql<BackfillRunRow[]>`
    SELECT run_id, workspace_id, status, updated_at
    FROM runs
    ${runScope}
  `;
  const iterations = await sql<BackfillRunRow[]>`
    SELECT iteration_id AS run_id, workspace_id, status, phase, updated_at
    FROM iteration_runs
    ${runScope}
  `;

  const stageDone = sql`status IN ('succeeded', 'failed', 'skipped')`;
  const taskDone = sql`status IN ('passed', 'failed', 'skipped', 'blocked', 'reverted', 'applied')`;

  const [
    stageAgg,
    latestStages,
    taskAgg,
    costs,
    artifactCounts,
    lastEvents,
    waitReasons,
  ] = await Promise.all([
    sql<
      Array<{ run_id: string; total: number | string; done: number | string }>
    >`
      SELECT
        run_id,
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN ${stageDone} THEN 1 ELSE 0 END), 0) AS done
      FROM stages
      GROUP BY run_id
    `,
    sql<Array<{ run_id: string; stage_id: string }>>`
      SELECT run_id, stage_id FROM (
        SELECT
          run_id,
          stage_id,
          ROW_NUMBER() OVER (
            PARTITION BY run_id
            ORDER BY COALESCE(started_at, '') DESC, stage_id DESC
          ) AS rn
        FROM stages
      ) ranked
      WHERE ranked.rn = 1
    `,
    sql<
      Array<{ run_id: string; total: number | string; done: number | string }>
    >`
      SELECT
        iteration_id AS run_id,
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN ${taskDone} THEN 1 ELSE 0 END), 0) AS done
      FROM iteration_tasks
      GROUP BY iteration_id
    `,
    sql<
      Array<{
        run_id: string;
        cny_micro: number | string;
        tokens: number | string;
      }>
    >`
      SELECT
        run_id,
        COALESCE(SUM(cost_cny_micro), 0) AS cny_micro,
        COALESCE(SUM(tokens), 0) AS tokens
      FROM budget_charges
      GROUP BY run_id
    `,
    sql<Array<{ run_id: string; count: number | string }>>`
      SELECT m.run_id, COUNT(*) AS count
      FROM artifacts a
      JOIN manifests m ON m.manifest_id = a.manifest_id
      GROUP BY m.run_id
    `,
    sql<Array<{ run_id: string; last_event_id: number | string }>>`
      SELECT run_id, MAX(event_id) AS last_event_id
      FROM activity_events
      WHERE run_id IS NOT NULL
      GROUP BY run_id
    `,
    sql<Array<{ run_id: string; summary: string | null }>>`
      SELECT run_id, summary FROM (
        SELECT
          run_id,
          summary,
          ROW_NUMBER() OVER (
            PARTITION BY run_id ORDER BY event_id DESC
          ) AS rn
        FROM activity_events
        WHERE run_id IS NOT NULL AND status = 'paused'
      ) ranked
      WHERE ranked.rn = 1
    `,
  ]);

  const stageByRun = indexBy(stageAgg, (row) => row.run_id);
  const latestStageByRun = indexBy(latestStages, (row) => row.run_id);
  const taskByRun = indexBy(taskAgg, (row) => row.run_id);
  const costByRun = indexBy(costs, (row) => row.run_id);
  const artifactByRun = indexBy(artifactCounts, (row) => row.run_id);
  const eventByRun = indexBy(lastEvents, (row) => row.run_id);
  const waitByRun = indexBy(waitReasons, (row) => row.run_id);

  let processed = 0;
  const all: BackfillRunRow[] = [...runs, ...iterations];
  for (const run of all) {
    const status = normalizeBackfillStatus(run.status);
    const stage = stageByRun.get(run.run_id);
    const task = taskByRun.get(run.run_id);
    const total = Number(stage?.total ?? task?.total ?? 0);
    const done = Number(stage?.done ?? task?.done ?? 0);
    const progress =
      total > 0
        ? clampProgress(done / total)
        : TERMINAL_STATUSES.has(status)
          ? 1
          : 0;
    const lastEventId = Number(eventByRun.get(run.run_id)?.last_event_id ?? 0);
    const waitReason =
      status === "paused" ? (waitByRun.get(run.run_id)?.summary ?? null) : null;
    const currentStage =
      latestStageByRun.get(run.run_id)?.stage_id ?? run.phase ?? null;

    await sql`
      INSERT INTO run_projection (
        run_id, workspace_id, status, current_stage, progress, cost_cny, tokens,
        artifact_count, wait_reason, last_event_id, version, updated_at
      ) VALUES (
        ${run.run_id}, ${run.workspace_id}, ${status}, ${currentStage},
        ${progress}, ${Number(costByRun.get(run.run_id)?.cny_micro ?? 0) / 1_000_000},
        ${Number(costByRun.get(run.run_id)?.tokens ?? 0)},
        ${Number(artifactByRun.get(run.run_id)?.count ?? 0)},
        ${waitReason}, ${lastEventId}, 1, ${toIso(run.updated_at)}
      )
      ON CONFLICT (run_id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        status = EXCLUDED.status,
        current_stage = EXCLUDED.current_stage,
        progress = EXCLUDED.progress,
        cost_cny = EXCLUDED.cost_cny,
        tokens = EXCLUDED.tokens,
        artifact_count = EXCLUDED.artifact_count,
        wait_reason = EXCLUDED.wait_reason,
        last_event_id = EXCLUDED.last_event_id,
        version = run_projection.version + 1,
        updated_at = EXCLUDED.updated_at
    `;
    processed += 1;
  }

  return { runs: processed };
}

function normalizeBackfillStatus(status: string): string {
  switch (status) {
    case "pending":
    case "running":
    case "paused":
    case "succeeded":
    case "failed":
    case "cancelled":
      return status;
    case "partial":
      return "succeeded";
    case "cancelling":
      return "running";
    default:
      return TERMINAL_STATUSES.has(status) ? status : "pending";
  }
}

function buildRunIdFilter(sql: SqlClient, runIds: readonly string[]) {
  if (runIds.length === 0) {
    return sql``;
  }
  let combined = sql`run_id = ${runIds[0]}`;
  for (const runId of runIds.slice(1)) {
    combined = sql`(${combined} OR run_id = ${runId})`;
  }
  return sql`AND (${combined})`;
}

function indexBy<T>(
  rows: readonly T[],
  key: (row: T) => string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    map.set(key(row), row);
  }
  return map;
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
}

function mapRunProjection(row: RunProjectionRow): RunProjection {
  return {
    runId: row.run_id,
    workspaceId: row.workspace_id,
    status: row.status,
    currentStage: row.current_stage,
    progress: clampProgress(Number(row.progress)),
    costCny: Number(row.cost_cny),
    tokens: Number(row.tokens),
    artifactCount: Number(row.artifact_count),
    waitReason: row.wait_reason,
    lastEventId: Number(row.last_event_id),
    version: Number(row.version),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
