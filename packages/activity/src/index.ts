import { type initStore, projectActivityEvent } from "@kit/store";
import type { ActivityEvent, ActivityFilter, ActivityInput } from "./types";

export * from "./types";

type Store = Awaited<ReturnType<typeof initStore>>;

interface ActivityRow {
  event_id: number;
  workspace_id: string;
  run_id: string | null;
  stage_id: string | null;
  agent_id: string | null;
  kind: string;
  status: string | null;
  tool: string | null;
  summary: string | null;
  payload: unknown;
  created_at: string | Date;
}

export async function appendActivity(
  store: Store,
  input: ActivityInput,
): Promise<number> {
  const at = input.createdAt ?? new Date().toISOString();
  const payload = JSON.stringify(redactPayload(input.payload ?? {}));
  return await store.sql.begin(async (tx) => {
    const rows = await tx<Array<{ event_id: number }>>`
      INSERT INTO activity_events (
        workspace_id, run_id, stage_id, agent_id, kind, status, tool,
        summary, payload, created_at
      ) VALUES (
        ${input.workspaceId ?? "default"}, ${input.runId ?? null},
        ${input.stageId ?? null}, ${input.agentId ?? null}, ${input.kind},
        ${input.status ?? null}, ${input.tool ?? null},
        ${input.summary?.slice(0, 2000) ?? null}, ${payload}, ${at}
      )
      RETURNING event_id
    `;
    const eventId = Number(rows[0]?.event_id ?? 0);
    if (!eventId) {
      throw new Error("failed to append activity event");
    }
    // Single choke point for the run world projection (87 §4.4): the upsert
    // shares this transaction so the projection never drifts from the log.
    await projectActivityEvent(tx, {
      eventId,
      workspaceId: input.workspaceId ?? "default",
      runId: input.runId ?? null,
      stageId: input.stageId ?? null,
      agentId: input.agentId ?? null,
      kind: input.kind,
      status: input.status ?? null,
      tool: input.tool ?? null,
      summary: input.summary?.slice(0, 2000) ?? null,
      createdAt: at,
    });
    await tx.notify(
      "kit_activity_events",
      JSON.stringify({
        runId: input.runId ?? null,
        agentId: input.agentId ?? null,
        kind: input.kind,
        eventId,
      }),
    );
    return eventId;
  });
}

export async function listActivity(
  store: Store,
  filter: ActivityFilter = {},
): Promise<ActivityEvent[]> {
  const limit = clampInt(filter.limit, 1, 500, 100);
  const workspaceFilter = filter.workspaceId
    ? store.sql`AND workspace_id = ${filter.workspaceId}`
    : store.sql``;
  const runFilter = filter.runId
    ? store.sql`AND run_id = ${filter.runId}`
    : store.sql``;
  const agentFilter = filter.agentId
    ? store.sql`AND agent_id = ${filter.agentId}`
    : store.sql``;
  const kindFilter = filter.kind
    ? store.sql`AND kind = ${filter.kind}`
    : store.sql``;

  let rows: ActivityRow[];
  if (filter.before === undefined && filter.after !== undefined) {
    rows = await store.sql<ActivityRow[]>`
      SELECT * FROM activity_events
      WHERE event_id > ${filter.after}
        ${workspaceFilter} ${runFilter} ${agentFilter} ${kindFilter}
      ORDER BY event_id ASC
      LIMIT ${limit}
    `;
  } else {
    const before = filter.before ?? Number.MAX_SAFE_INTEGER;
    rows = await store.sql<ActivityRow[]>`
      SELECT * FROM activity_events
      WHERE event_id < ${before}
        ${workspaceFilter} ${runFilter} ${agentFilter} ${kindFilter}
      ORDER BY event_id DESC
      LIMIT ${limit}
    `;
    rows.reverse();
  }
  return rows.map(mapRow);
}

function mapRow(row: ActivityRow): ActivityEvent {
  return {
    eventId: Number(row.event_id),
    workspaceId: row.workspace_id,
    runId: row.run_id,
    stageId: row.stage_id,
    agentId: row.agent_id,
    kind: row.kind,
    status: row.status,
    tool: row.tool,
    summary: row.summary,
    payload: parsePayload(row.payload),
    createdAt: toIso(row.created_at),
  };
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

/**
 * Recursively redacts secret-looking object keys and bounds payload size.
 * Shared by activity payloads and the stage transcript (30 §3.4).
 */
export function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactPayload(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/key|token|secret|password|authorization|cookie/i.test(key)) {
        if (typeof item === "string" || (item && typeof item === "object")) {
          result[key] = "[redacted]";
          continue;
        }
      }
      result[key] = redactPayload(item, depth + 1);
    }
    return result;
  }
  return value;
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
