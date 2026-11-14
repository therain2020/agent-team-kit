import type { SqlClient } from "@kit/store";

export interface AutopilotState {
  workspaceId: string;
  packDir: string;
  enabled: boolean;
  lastTickAt: string | null;
  nextRuns: Record<string, string>;
  day: string | null;
  runsToday: number;
  spentToday: number;
  lastError: string | null;
  updatedAt: string;
  version: number;
}

export async function ensureState(
  sql: SqlClient,
  workspaceId: string,
  packDir: string,
  defaultEnabled: boolean,
  now: Date = new Date(),
): Promise<AutopilotState> {
  const existing = await getState(sql, workspaceId, packDir);
  if (existing) {
    return resetDaily(existing, now);
  }
  const updatedAt = now.toISOString();
  await sql`
    INSERT INTO autopilot_state (
      workspace_id, pack_dir, enabled, last_tick_at, next_runs,
      day, runs_today, spent_today, last_error, updated_at
    ) VALUES (
      ${workspaceId}, ${packDir}, ${defaultEnabled}, NULL, ${JSON.stringify({})}::jsonb,
      NULL, 0, 0, NULL, ${updatedAt}
    )
    ON CONFLICT (workspace_id, pack_dir) DO NOTHING
  `;
  const created = await getState(sql, workspaceId, packDir);
  if (!created) {
    throw new Error("failed to create autopilot state");
  }
  return resetDaily(created, now);
}

export async function getState(
  sql: SqlClient,
  workspaceId: string,
  packDir: string,
): Promise<AutopilotState | null> {
  const rows = await sql<
    Array<{
      workspace_id: string;
      pack_dir: string;
      enabled: boolean;
      last_tick_at: Date | string | null;
      next_runs: Record<string, string> | string | null;
      day: Date | string | null;
      runs_today: number;
      spent_today: string | number;
      last_error: string | null;
      updated_at: Date | string;
      version?: number;
    }>
  >`
    SELECT * FROM autopilot_state
    WHERE workspace_id = ${workspaceId} AND pack_dir = ${packDir}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    return null;
  }
  return fromRow(row);
}

export async function listStates(
  sql: SqlClient,
  workspaceId: string,
): Promise<AutopilotState[]> {
  const rows = await sql<
    Array<{
      workspace_id: string;
      pack_dir: string;
      enabled: boolean;
      last_tick_at: Date | string | null;
      next_runs: Record<string, string> | string | null;
      day: Date | string | null;
      runs_today: number;
      spent_today: string | number;
      last_error: string | null;
      updated_at: Date | string;
      version?: number;
    }>
  >`
    SELECT * FROM autopilot_state WHERE workspace_id = ${workspaceId}
    ORDER BY pack_dir ASC
  `;
  return rows.map(fromRow);
}

export async function saveState(
  sql: SqlClient,
  state: AutopilotState,
): Promise<boolean> {
  const rows = await sql<Array<{ version: number }>>`
    UPDATE autopilot_state SET
      enabled = ${state.enabled},
      last_tick_at = ${state.lastTickAt},
      next_runs = ${JSON.stringify(state.nextRuns)}::jsonb,
      day = ${state.day},
      runs_today = ${state.runsToday},
      spent_today = ${state.spentToday},
      last_error = ${state.lastError},
      updated_at = ${state.updatedAt},
      version = version + 1
    WHERE workspace_id = ${state.workspaceId}
      AND pack_dir = ${state.packDir}
      AND version = ${state.version}
    RETURNING version
  `;
  const row = rows[0];
  if (!row) {
    return false;
  }
  state.version = row.version;
  return true;
}

export function resetDaily(
  state: AutopilotState,
  now: Date = new Date(),
): AutopilotState {
  const today = now.toISOString().slice(0, 10);
  if (state.day === today) {
    return state;
  }
  return {
    ...state,
    day: today,
    runsToday: 0,
    spentToday: 0,
  };
}

function fromRow(row: {
  workspace_id: string;
  pack_dir: string;
  enabled: boolean;
  last_tick_at: Date | string | null;
  next_runs: Record<string, string> | string | null;
  day: Date | string | null;
  runs_today: number;
  spent_today: string | number;
  last_error: string | null;
  updated_at: Date | string;
  version?: number;
}): AutopilotState {
  return {
    workspaceId: row.workspace_id,
    packDir: row.pack_dir,
    enabled: Boolean(row.enabled),
    lastTickAt: toIso(row.last_tick_at),
    nextRuns: normalizeJson(row.next_runs),
    day: toIso(row.day)?.slice(0, 10) ?? null,
    runsToday: Number(row.runs_today ?? 0),
    spentToday: Number(row.spent_today ?? 0),
    lastError: row.last_error,
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
    version: Number(row.version ?? 0),
  };
}

function toIso(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeJson(
  value: Record<string, string> | string | null,
): Record<string, string> {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return value;
}
