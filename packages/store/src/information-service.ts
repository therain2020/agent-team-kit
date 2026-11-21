import type {
  InformationEvent,
  InformationSensitivity,
  InformationSourceKind,
} from "@kit/core";
import type { SqlClient } from "./db";

/**
 * Information plane persistence (98 §2 / 98 §3.1, 10 §3.1).
 *
 * Three stores back the continuous collector:
 * - `information_raw_captures`: append-only, immutable raw captures keyed by the
 *   fetch identity `capture_key = sha256(source_id + raw_bytes)`. A repeated
 *   fetch is a no-op, so duplicate counts never inflate storage.
 * - `information_events`: the current {@link InformationEvent} per `dedupe_key`.
 *   The unique `(workspace_id, dedupe_key)` index makes intake idempotent even
 *   across concurrent collectors.
 * - `source_health`: per-source success/failure/latency/yield/cost, with a
 *   consecutive-failure counter that drives degradation (61).
 *
 * Like approvals and budgets this talks to the shared {@link SqlClient} so one
 * implementation keeps Postgres and SQLite in lockstep; DDL lives in
 * `schema-text.ts`.
 */

export interface InformationStore {
  sql: SqlClient;
}

export interface RawCaptureRecord {
  captureKey: string;
  workspaceId: string;
  sourceId: string;
  fetchedAt: string;
  contentRef: string;
  contentHash: string;
  content: string;
  bytes: number;
  createdAt: string;
}

export interface RecordRawCaptureInput {
  captureKey: string;
  workspaceId?: string;
  sourceId: string;
  fetchedAt: string;
  contentRef: string;
  contentHash: string;
  content: string;
  bytes?: number;
  createdAt?: string;
}

export interface InformationEventRecord {
  eventId: string;
  eventType: string;
  workspaceId: string;
  sourceId: string;
  sourceKind: InformationSourceKind;
  captureKey: string;
  dedupeKey: string;
  itemRef: string;
  url: string;
  title: string;
  occurredAt: string;
  receivedAt: string;
  sensitivity: InformationSensitivity;
  payload: InformationEvent;
  createdAt: string;
}

export interface AppendInformationEventInput {
  event: InformationEvent;
  workspaceId?: string;
  /** Convenience columns for queries/UI; default to derived values. */
  itemRef?: string;
  url?: string;
  title?: string;
  createdAt?: string;
}

export interface ListInformationEventsQuery {
  workspaceId?: string;
  sourceId?: string;
  eventType?: string;
  /** Only events created strictly after this ISO timestamp (sweep cursor). */
  createdAfter?: string;
  /** Newest-first by default; `asc` is the replay-friendly order for sweeps. */
  order?: "asc" | "desc";
  limit?: number;
}

export interface SourceHealthRecord {
  workspaceId: string;
  sourceId: string;
  runs: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  itemsCollected: number;
  eventsCreated: number;
  latencyMsTotal: number;
  lastLatencyMs: number | null;
  totalCostCnyMicro: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  degraded: boolean;
  updatedAt: string;
}

export interface RecordSourceRunInput {
  sourceId: string;
  ok: boolean;
  latencyMs: number;
  workspaceId?: string;
  items?: number;
  events?: number;
  error?: string | null;
  costCnyMicro?: number;
  at?: string;
  /** Consecutive failures before the source flips to `degraded`. */
  failureThreshold?: number;
}

interface CaptureRow {
  capture_key: string;
  workspace_id: string;
  source_id: string;
  fetched_at: string | Date;
  content_ref: string;
  content_hash: string;
  content: string;
  bytes: number | string;
  created_at: string | Date;
}

interface EventRow {
  event_id: string;
  event_type: string;
  workspace_id: string;
  source_id: string;
  source_kind: string;
  capture_key: string;
  dedupe_key: string;
  item_ref: string;
  url: string;
  title: string;
  occurred_at: string | Date;
  received_at: string | Date;
  sensitivity: string;
  payload: unknown;
  created_at: string | Date;
}

interface HealthRow {
  workspace_id: string;
  source_id: string;
  runs: number | string;
  successes: number | string;
  failures: number | string;
  consecutive_failures: number | string;
  items_collected: number | string;
  events_created: number | string;
  latency_ms_total: number | string;
  last_latency_ms: number | string | null;
  total_cost_cny_micro: number | string;
  last_success_at: string | Date | null;
  last_failure_at: string | Date | null;
  last_error: string | null;
  degraded: boolean | number;
  updated_at: string | Date;
}

const DEFAULT_WORKSPACE = "default";
const DEFAULT_FAILURE_THRESHOLD = 3;

export class InformationService {
  constructor(private readonly store: InformationStore) {}

  private get sql(): SqlClient {
    return this.store.sql;
  }

  /** Append a raw capture; a repeated `capture_key` returns the original. */
  async recordCapture(
    input: RecordRawCaptureInput,
  ): Promise<{ inserted: boolean; capture: RawCaptureRecord }> {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE;
    const createdAt = input.createdAt ?? input.fetchedAt;
    const bytes = input.bytes ?? Buffer.byteLength(input.content, "utf8");

    const inserted = await this.sql<CaptureRow[]>`
      INSERT INTO information_raw_captures (
        capture_key, workspace_id, source_id, fetched_at, content_ref,
        content_hash, content, bytes, created_at
      ) VALUES (
        ${input.captureKey}, ${workspaceId}, ${input.sourceId}, ${input.fetchedAt},
        ${input.contentRef}, ${input.contentHash}, ${input.content}, ${bytes},
        ${createdAt}
      ) ON CONFLICT (capture_key) DO NOTHING
      RETURNING *
    `;
    const row = inserted[0] ?? (await this.findCapture(input.captureKey));
    if (!row) {
      throw new Error("failed to record raw capture");
    }
    return { inserted: Boolean(inserted[0]), capture: mapCapture(row) };
  }

  private async findCapture(captureKey: string): Promise<CaptureRow | null> {
    const rows = await this.sql<CaptureRow[]>`
      SELECT * FROM information_raw_captures
      WHERE capture_key = ${captureKey}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /** Persist an event; an existing `dedupe_key` returns the first-stored row. */
  async appendEvent(
    input: AppendInformationEventInput,
  ): Promise<{ inserted: boolean; event: InformationEventRecord }> {
    const event = input.event;
    const workspaceId = input.workspaceId ?? event.workspaceId;
    const itemRef = input.itemRef ?? event.itemRefs[0] ?? event.eventId;
    const createdAt = input.createdAt ?? event.receivedAt;
    const payload = JSON.stringify(event);

    const inserted = await this.sql<EventRow[]>`
      INSERT INTO information_events (
        event_id, event_type, workspace_id, source_id, source_kind, capture_key,
        dedupe_key, item_ref, url, title, occurred_at, received_at, sensitivity,
        payload, created_at
      ) VALUES (
        ${event.eventId}, ${event.type}, ${workspaceId}, ${event.sourceId},
        ${event.sourceKind}, ${event.captureKey}, ${event.dedupeKey}, ${itemRef},
        ${input.url ?? ""}, ${input.title ?? ""}, ${event.occurredAt},
        ${event.receivedAt}, ${event.sensitivity}, ${payload}, ${createdAt}
      ) ON CONFLICT (workspace_id, dedupe_key) DO NOTHING
      RETURNING *
    `;
    const row =
      inserted[0] ??
      (await this.findEventByDedupe(workspaceId, event.dedupeKey));
    if (!row) {
      throw new Error("failed to append information event");
    }
    return { inserted: Boolean(inserted[0]), event: mapEvent(row) };
  }

  private async findEventByDedupe(
    workspaceId: string,
    dedupeKey: string,
  ): Promise<EventRow | null> {
    const rows = await this.sql<EventRow[]>`
      SELECT * FROM information_events
      WHERE workspace_id = ${workspaceId} AND dedupe_key = ${dedupeKey}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async getEvent(
    workspaceId: string,
    eventId: string,
  ): Promise<InformationEventRecord | null> {
    const rows = await this.sql<EventRow[]>`
      SELECT * FROM information_events
      WHERE workspace_id = ${workspaceId} AND event_id = ${eventId}
      LIMIT 1
    `;
    return rows[0] ? mapEvent(rows[0]) : null;
  }

  /** Query newest-first, optionally scoped to a source or event type. */
  async listEvents(
    query: ListInformationEventsQuery = {},
  ): Promise<InformationEventRecord[]> {
    const workspaceId = query.workspaceId ?? DEFAULT_WORKSPACE;
    const limit = clampInt(query.limit, 1, 500, 50);
    const sourceFilter = query.sourceId
      ? this.sql`AND source_id = ${query.sourceId}`
      : this.sql``;
    const typeFilter = query.eventType
      ? this.sql`AND event_type = ${query.eventType}`
      : this.sql``;
    const afterFilter = query.createdAfter
      ? this.sql`AND created_at > ${query.createdAfter}`
      : this.sql``;

    // Direction is a closed enum, so the two branches are the only shapes the
    // query builder ever sees (no user string reaches the ORDER BY clause).
    const rows =
      query.order === "asc"
        ? await this.sql<EventRow[]>`
          SELECT * FROM information_events
          WHERE workspace_id = ${workspaceId}
            ${sourceFilter} ${typeFilter} ${afterFilter}
          ORDER BY created_at ASC, event_id ASC
          LIMIT ${limit}
        `
        : await this.sql<EventRow[]>`
          SELECT * FROM information_events
          WHERE workspace_id = ${workspaceId}
            ${sourceFilter} ${typeFilter} ${afterFilter}
          ORDER BY created_at DESC, event_id DESC
          LIMIT ${limit}
        `;
    return rows.map(mapEvent);
  }

  /** Whether an event with this dedupe key already exists (seen set probe). */
  async isSeen(workspaceId: string, dedupeKey: string): Promise<boolean> {
    const rows = await this.sql<{ one: number }[]>`
      SELECT 1 AS one FROM information_events
      WHERE workspace_id = ${workspaceId} AND dedupe_key = ${dedupeKey}
      LIMIT 1
    `;
    return rows.length > 0;
  }

  /**
   * Fold one collection attempt into the source's health row. Successes reset
   * the consecutive-failure counter; a failure increments it and flips
   * `degraded` once it reaches the threshold (61).
   */
  async recordSourceRun(
    input: RecordSourceRunInput,
  ): Promise<SourceHealthRecord> {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE;
    const at = input.at ?? new Date().toISOString();
    const latency = Math.max(0, Math.trunc(input.latencyMs));

    if (input.ok) {
      const items = Math.max(0, Math.trunc(input.items ?? 0));
      const events = Math.max(0, Math.trunc(input.events ?? 0));
      const cost = Math.max(0, Math.trunc(input.costCnyMicro ?? 0));
      await this.sql`
        INSERT INTO source_health (
          workspace_id, source_id, runs, successes, failures,
          consecutive_failures, items_collected, events_created,
          latency_ms_total, last_latency_ms, total_cost_cny_micro,
          last_success_at, degraded, updated_at
        ) VALUES (
          ${workspaceId}, ${input.sourceId}, 1, 1, 0, 0, ${items}, ${events},
          ${latency}, ${latency}, ${cost}, ${at}, ${false}, ${at}
        )
        ON CONFLICT (workspace_id, source_id) DO UPDATE SET
          runs = source_health.runs + 1,
          successes = source_health.successes + 1,
          consecutive_failures = 0,
          items_collected = source_health.items_collected + ${items},
          events_created = source_health.events_created + ${events},
          latency_ms_total = source_health.latency_ms_total + ${latency},
          last_latency_ms = ${latency},
          total_cost_cny_micro = source_health.total_cost_cny_micro + ${cost},
          last_success_at = ${at},
          degraded = ${false},
          updated_at = ${at}
      `;
    } else {
      const error = input.error ?? "unknown error";
      const threshold = Math.max(
        1,
        Math.trunc(input.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD),
      );
      await this.sql`
        INSERT INTO source_health (
          workspace_id, source_id, runs, successes, failures,
          consecutive_failures, items_collected, events_created,
          latency_ms_total, last_latency_ms, total_cost_cny_micro,
          last_failure_at, last_error, degraded, updated_at
        ) VALUES (
          ${workspaceId}, ${input.sourceId}, 1, 0, 1, 1, 0, 0,
          ${latency}, ${latency}, 0, ${at}, ${error}, ${threshold <= 1}, ${at}
        )
        ON CONFLICT (workspace_id, source_id) DO UPDATE SET
          runs = source_health.runs + 1,
          failures = source_health.failures + 1,
          consecutive_failures = source_health.consecutive_failures + 1,
          last_latency_ms = ${latency},
          last_failure_at = ${at},
          last_error = ${error},
          degraded = (source_health.consecutive_failures + 1) >= ${threshold},
          updated_at = ${at}
      `;
    }

    const health = await this.getSourceHealth(workspaceId, input.sourceId);
    if (!health) {
      throw new Error("failed to record source health");
    }
    return health;
  }

  async getSourceHealth(
    workspaceId: string,
    sourceId: string,
  ): Promise<SourceHealthRecord | null> {
    const rows = await this.sql<HealthRow[]>`
      SELECT * FROM source_health
      WHERE workspace_id = ${workspaceId} AND source_id = ${sourceId}
      LIMIT 1
    `;
    return rows[0] ? mapHealth(rows[0]) : null;
  }

  async listSourceHealth(
    workspaceId: string = DEFAULT_WORKSPACE,
  ): Promise<SourceHealthRecord[]> {
    const rows = await this.sql<HealthRow[]>`
      SELECT * FROM source_health
      WHERE workspace_id = ${workspaceId}
      ORDER BY source_id ASC
    `;
    return rows.map(mapHealth);
  }
}

function mapCapture(row: CaptureRow): RawCaptureRecord {
  return {
    captureKey: row.capture_key,
    workspaceId: row.workspace_id,
    sourceId: row.source_id,
    fetchedAt: toIso(row.fetched_at) ?? "",
    contentRef: row.content_ref,
    contentHash: row.content_hash,
    content: row.content,
    bytes: Number(row.bytes),
    createdAt: toIso(row.created_at) ?? "",
  };
}

function mapEvent(row: EventRow): InformationEventRecord {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    workspaceId: row.workspace_id,
    sourceId: row.source_id,
    sourceKind: row.source_kind as InformationSourceKind,
    captureKey: row.capture_key,
    dedupeKey: row.dedupe_key,
    itemRef: row.item_ref,
    url: row.url,
    title: row.title,
    occurredAt: toIso(row.occurred_at) ?? "",
    receivedAt: toIso(row.received_at) ?? "",
    sensitivity: row.sensitivity as InformationSensitivity,
    payload: parsePayload(row.payload),
    createdAt: toIso(row.created_at) ?? "",
  };
}

function mapHealth(row: HealthRow): SourceHealthRecord {
  return {
    workspaceId: row.workspace_id,
    sourceId: row.source_id,
    runs: Number(row.runs),
    successes: Number(row.successes),
    failures: Number(row.failures),
    consecutiveFailures: Number(row.consecutive_failures),
    itemsCollected: Number(row.items_collected),
    eventsCreated: Number(row.events_created),
    latencyMsTotal: Number(row.latency_ms_total),
    lastLatencyMs:
      row.last_latency_ms === null ? null : Number(row.last_latency_ms),
    totalCostCnyMicro: Number(row.total_cost_cny_micro),
    lastSuccessAt: toIso(row.last_success_at),
    lastFailureAt: toIso(row.last_failure_at),
    lastError: row.last_error,
    degraded: row.degraded === true || Number(row.degraded) === 1,
    updatedAt: toIso(row.updated_at) ?? "",
  };
}

function parsePayload(value: unknown): InformationEvent {
  if (typeof value !== "string") {
    return value as InformationEvent;
  }
  try {
    return JSON.parse(value) as InformationEvent;
  } catch {
    return {} as InformationEvent;
  }
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
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
