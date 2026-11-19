import {
  type CircuitBreakerConfig,
  type CircuitBreakerRecord,
  type CircuitDimensions,
  type CircuitSample,
  type CircuitScopeType,
  type CircuitState,
  type CircuitTransition,
  applyCircuitOutcome,
  circuitAccess,
  circuitScopes,
  loadCircuitBreakerConfig,
  newCircuitBreakerRecord,
  newId,
  resetCircuitBreaker,
} from "@kit/core";
import type { SqlClient, StoreDriverName } from "./db";

export interface CircuitBreakerStore {
  sql: SqlClient;
  driver: StoreDriverName;
}

export type CircuitBreakerEventAction =
  | "trip"
  | "recover"
  | "reset"
  | "suppressed"
  | "half_open";

export interface CircuitBreakerEventRecord {
  eventId: string;
  occurredAt: string;
  workspaceId: string;
  scopeType: CircuitScopeType;
  scopeKey: string;
  action: CircuitBreakerEventAction;
  reason: string | null;
  detail: Record<string, unknown>;
}

export interface CircuitScopeTransition {
  record: CircuitBreakerRecord;
  transition: CircuitTransition;
  /** The previous state, for notifications. */
  previousState: CircuitState;
}

export interface CircuitAccessOutcome {
  allowed: boolean;
  reason: string | null;
  blockedBy: CircuitBreakerRecord | null;
  transitions: CircuitScopeTransition[];
}

export interface CircuitRecordOutcome {
  transitions: CircuitScopeTransition[];
}

export interface ResetCircuitBreakerInput {
  scopeType: CircuitScopeType;
  scopeKey: string;
  actor: string;
  reason: string;
  now?: Date;
}

interface CircuitBreakerRow {
  scope_type: string;
  scope_key: string;
  workspace_id: string;
  state: string;
  consecutive_failures: number | string;
  window: unknown;
  opened_at: string | Date | null;
  half_open_started_at: string | Date | null;
  half_open_successes: number | string;
  last_trip_at: string | Date | null;
  recovered_at: string | Date | null;
  trip_count: number | string;
  updated_at: string | Date;
}

interface CircuitBreakerEventRow {
  event_id: string;
  occurred_at: string | Date;
  workspace_id: string;
  scope_type: string;
  scope_key: string;
  action: string;
  reason: string | null;
  detail: unknown;
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function toInt(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function fromRow(row: CircuitBreakerRow): CircuitBreakerRecord {
  return {
    scopeType: row.scope_type as CircuitScopeType,
    scopeKey: row.scope_key,
    workspaceId: row.workspace_id,
    state: row.state as CircuitState,
    consecutiveFailures: toInt(row.consecutive_failures),
    window: parseJson<CircuitSample[]>(row.window, []),
    openedAt: toIso(row.opened_at),
    halfOpenStartedAt: toIso(row.half_open_started_at),
    halfOpenSuccesses: toInt(row.half_open_successes),
    lastTripAt: toIso(row.last_trip_at),
    recoveredAt: toIso(row.recovered_at),
    tripCount: toInt(row.trip_count),
    updatedAt: toIso(row.updated_at) as string,
  };
}

function fromEventRow(row: CircuitBreakerEventRow): CircuitBreakerEventRecord {
  return {
    eventId: row.event_id,
    occurredAt: toIso(row.occurred_at) as string,
    workspaceId: row.workspace_id,
    scopeType: row.scope_type as CircuitScopeType,
    scopeKey: row.scope_key,
    action: row.action as CircuitBreakerEventAction,
    reason: row.reason,
    detail: parseJson<Record<string, unknown>>(row.detail, {}),
  };
}

/**
 * Persistence for the circuit breaker state machine (60 §3.2).
 *
 * The service owns the read-modify-write of each scope and records every
 * transition to `circuit_breaker_events` for glass-box inspection. Callers are
 * responsible for turning `trip` / `recover` transitions into notifications.
 */
export class CircuitBreakerService {
  private readonly config: CircuitBreakerConfig;

  constructor(
    private readonly store: CircuitBreakerStore,
    config?: CircuitBreakerConfig,
  ) {
    this.config = config ?? loadCircuitBreakerConfig();
  }

  getConfig(): CircuitBreakerConfig {
    return this.config;
  }

  async get(
    scopeType: CircuitScopeType,
    scopeKey: string,
  ): Promise<CircuitBreakerRecord | null> {
    const rows = await this.store.sql<CircuitBreakerRow[]>`
      SELECT * FROM circuit_breakers
      WHERE scope_type = ${scopeType} AND scope_key = ${scopeKey}
      LIMIT 1
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async list(
    options: { workspaceId?: string; limit?: number } = {},
  ): Promise<CircuitBreakerRecord[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const rows = options.workspaceId
      ? await this.store.sql<CircuitBreakerRow[]>`
          SELECT * FROM circuit_breakers
          WHERE workspace_id = ${options.workspaceId}
          ORDER BY updated_at DESC
          LIMIT ${limit}
        `
      : await this.store.sql<CircuitBreakerRow[]>`
          SELECT * FROM circuit_breakers
          ORDER BY updated_at DESC
          LIMIT ${limit}
        `;
    return rows.map(fromRow);
  }

  async listEvents(limit = 100): Promise<CircuitBreakerEventRecord[]> {
    const capped = Math.max(1, Math.min(limit, 1000));
    const rows = await this.store.sql<CircuitBreakerEventRow[]>`
      SELECT * FROM circuit_breaker_events
      ORDER BY occurred_at DESC
      LIMIT ${capped}
    `;
    return rows.map(fromEventRow);
  }

  /**
   * Fast-fail gate. Evaluates every scope the request belongs to and admits it
   * only when none is open. Cooldown-elapsed open breakers are advanced to
   * half-open so the request becomes the probe.
   */
  async acquire(
    dims: CircuitDimensions,
    now: Date = new Date(),
  ): Promise<CircuitAccessOutcome> {
    const transitions: CircuitScopeTransition[] = [];
    let blockedBy: CircuitBreakerRecord | null = null;
    let reason: string | null = null;

    for (const scope of circuitScopes(dims)) {
      const record = await this.get(scope.scopeType, scope.scopeKey);
      const decision = circuitAccess(record, now, this.config);
      if (decision.transition === "open_to_half_open" && decision.record) {
        await this.persist(decision.record);
        await this.appendEvent(decision.record, "half_open", {
          previousState: "open",
        });
        transitions.push({
          record: decision.record,
          transition: decision.transition,
          previousState: "open",
        });
      }
      if (!decision.allowed) {
        blockedBy ??= decision.record;
        reason ??= decision.reason;
      }
    }

    return {
      allowed: blockedBy === null,
      reason,
      blockedBy,
      transitions,
    };
  }

  /**
   * Fold one call outcome into every scope the request belongs to. The first
   * scope that trips is enough to fast-fail the next request, but each scope is
   * evaluated independently so failure counters stay dimension-local.
   */
  async record(
    dims: CircuitDimensions,
    success: boolean,
    now: Date = new Date(),
  ): Promise<CircuitRecordOutcome> {
    const transitions: CircuitScopeTransition[] = [];

    for (const scope of circuitScopes(dims)) {
      const existing = await this.get(scope.scopeType, scope.scopeKey);
      const current =
        existing ?? newCircuitBreakerRecord(scope, now.toISOString());
      const result = applyCircuitOutcome(current, success, now, this.config);
      const previousState = current.state;

      // A closed success still has to be written back so the stored failure
      // counters and window reset; skip writes only for brand-new healthy
      // breakers that carry no state worth persisting.
      if (existing || !success || result.transition !== "none") {
        await this.persist(result.record);
      }

      if (result.transition === "none") {
        continue;
      }
      if (result.transition === "trip") {
        await this.appendEvent(result.record, "trip", {
          previousState,
          consecutiveFailures: result.record.consecutiveFailures,
          state: result.record.state,
        });
      } else if (result.transition === "recover") {
        await this.appendEvent(result.record, "recover", { previousState });
      } else if (result.transition === "suppressed") {
        await this.appendEvent(result.record, "suppressed", {
          previousState,
          recoveredAt: result.record.recoveredAt,
          minRecoveryIntervalMs: this.config.minRecoveryIntervalMs,
        });
      }
      transitions.push({
        record: result.record,
        transition: result.transition,
        previousState,
      });
    }

    return { transitions };
  }

  /**
   * Operator reset: return a breaker to a clean closed state. The reset counts
   * as a recovery, so the 1h re-trip debounce still applies afterwards.
   */
  async reset(
    input: ResetCircuitBreakerInput,
  ): Promise<CircuitBreakerRecord | null> {
    const now = input.now ?? new Date();
    const current = await this.get(input.scopeType, input.scopeKey);
    if (!current) {
      return null;
    }
    const reset = resetCircuitBreaker(current, now);
    await this.persist(reset);
    await this.appendEvent(reset, "reset", {
      previousState: current.state,
      actor: input.actor,
      reason: input.reason,
    });
    return reset;
  }

  private async persist(record: CircuitBreakerRecord): Promise<void> {
    const window = JSON.stringify(record.window);
    await this.store.sql`
      INSERT INTO circuit_breakers (
        scope_type, scope_key, workspace_id, state, consecutive_failures,
        window, opened_at, half_open_started_at, half_open_successes,
        last_trip_at, recovered_at, trip_count, updated_at
      ) VALUES (
        ${record.scopeType}, ${record.scopeKey}, ${record.workspaceId},
        ${record.state}, ${record.consecutiveFailures}, ${window},
        ${record.openedAt}, ${record.halfOpenStartedAt},
        ${record.halfOpenSuccesses}, ${record.lastTripAt},
        ${record.recoveredAt}, ${record.tripCount}, ${record.updatedAt}
      )
      ON CONFLICT (scope_type, scope_key) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        state = EXCLUDED.state,
        consecutive_failures = EXCLUDED.consecutive_failures,
        window = EXCLUDED.window,
        opened_at = EXCLUDED.opened_at,
        half_open_started_at = EXCLUDED.half_open_started_at,
        half_open_successes = EXCLUDED.half_open_successes,
        last_trip_at = EXCLUDED.last_trip_at,
        recovered_at = EXCLUDED.recovered_at,
        trip_count = EXCLUDED.trip_count,
        updated_at = EXCLUDED.updated_at
    `;
  }

  private async appendEvent(
    record: CircuitBreakerRecord,
    action: CircuitBreakerEventAction,
    detail: Record<string, unknown> & { reason?: string },
  ): Promise<void> {
    const occurredAt = record.updatedAt;
    const reason = detail.reason ?? null;
    await this.store.sql`
      INSERT INTO circuit_breaker_events (
        event_id, occurred_at, workspace_id, scope_type, scope_key,
        action, reason, detail
      ) VALUES (
        ${newId("cbe")}, ${occurredAt}, ${record.workspaceId},
        ${record.scopeType}, ${record.scopeKey}, ${action}, ${reason},
        ${JSON.stringify(detail)}
      )
      ON CONFLICT DO NOTHING
    `;
  }
}
