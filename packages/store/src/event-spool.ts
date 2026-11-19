import type { SqlClient } from "./db";

/**
 * SQL-backed persistence for the local event spool (61 §3.2, D-38).
 *
 * The shape mirrors the `SpoolStore` port exported by `@kit/store`'s caller
 * (`@kit/queue`) structurally; `@kit/store` intentionally does not depend on
 * the queue package. Payloads are stored base64 so both drivers round-trip
 * arbitrary bytes.
 *
 * Delivered rows are retained as delivery history — that is what makes replay
 * dedupe by `event_id` survive a restart. `pruneDelivered` bounds that history.
 */

export const SPOOL_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type SpoolPriority = (typeof SPOOL_PRIORITIES)[number];

export interface EventSpoolRecord {
  spoolId?: number;
  eventId: string;
  subject: string;
  priority: SpoolPriority;
  data: Uint8Array;
  workspaceId: string;
  enqueuedAt: string;
}

interface SpoolRow {
  spool_id: number | string;
  event_id: string;
  subject: string;
  priority: string;
  payload: string;
  workspace_id: string;
  enqueued_at: string | Date;
  delivered_at: string | Date | null;
}

export class SqlEventSpoolStore {
  constructor(private readonly sql: SqlClient) {}

  /** Insert unless the event id is already buffered or delivered. */
  async append(record: EventSpoolRecord): Promise<boolean> {
    const rows = await this.sql<SpoolRow[]>`
      INSERT INTO event_spool (
        event_id, subject, priority, payload, workspace_id, enqueued_at
      ) VALUES (
        ${record.eventId}, ${record.subject}, ${record.priority},
        ${encodePayload(record.data)}, ${record.workspaceId}, ${record.enqueuedAt}
      ) ON CONFLICT (event_id) DO NOTHING
      RETURNING spool_id
    `;
    return rows.length > 0;
  }

  async listPending(): Promise<EventSpoolRecord[]> {
    const rows = await this.sql<SpoolRow[]>`
      SELECT * FROM event_spool
      WHERE delivered_at IS NULL
      ORDER BY spool_id ASC
    `;
    return rows.map(toRecord);
  }

  async remove(eventIds: readonly string[]): Promise<number> {
    let removed = 0;
    for (const eventId of eventIds) {
      const rows = await this.sql<{ spool_id: number | string }[]>`
        SELECT spool_id FROM event_spool
        WHERE event_id = ${eventId} AND delivered_at IS NULL
      `;
      if (rows.length === 0) {
        continue;
      }
      await this.sql`
        DELETE FROM event_spool
        WHERE event_id = ${eventId} AND delivered_at IS NULL
      `;
      removed += 1;
    }
    return removed;
  }

  async markDelivered(eventId: string, deliveredAt: string): Promise<boolean> {
    const rows = await this.sql<{ spool_id: number | string }[]>`
      SELECT spool_id FROM event_spool
      WHERE event_id = ${eventId} AND delivered_at IS NULL
    `;
    if (rows.length === 0) {
      return false;
    }
    await this.sql`
      UPDATE event_spool SET delivered_at = ${deliveredAt}
      WHERE event_id = ${eventId} AND delivered_at IS NULL
    `;
    return true;
  }

  async isDelivered(eventId: string): Promise<boolean> {
    const rows = await this.sql<{ spool_id: number | string }[]>`
      SELECT spool_id FROM event_spool
      WHERE event_id = ${eventId} AND delivered_at IS NOT NULL
      LIMIT 1
    `;
    return rows.length > 0;
  }

  /** True when the id is buffered or already delivered. */
  async has(eventId: string): Promise<boolean> {
    const rows = await this.sql<{ spool_id: number | string }[]>`
      SELECT spool_id FROM event_spool
      WHERE event_id = ${eventId}
      LIMIT 1
    `;
    return rows.length > 0;
  }

  /** Bound the delivery history; returns how many rows were removed. */
  async pruneDelivered(before: string): Promise<number> {
    const rows = await this.sql<{ spool_id: number | string }[]>`
      SELECT spool_id FROM event_spool
      WHERE delivered_at IS NOT NULL AND delivered_at < ${before}
    `;
    if (rows.length === 0) {
      return 0;
    }
    await this.sql`
      DELETE FROM event_spool
      WHERE delivered_at IS NOT NULL AND delivered_at < ${before}
    `;
    return rows.length;
  }
}

function toRecord(row: SpoolRow): EventSpoolRecord {
  return {
    spoolId: Number(row.spool_id),
    eventId: row.event_id,
    subject: row.subject,
    priority: normalizePriority(row.priority),
    data: decodePayload(row.payload),
    workspaceId: row.workspace_id,
    enqueuedAt: toIso(row.enqueued_at),
  };
}

function normalizePriority(value: string): SpoolPriority {
  return (SPOOL_PRIORITIES as readonly string[]).includes(value)
    ? (value as SpoolPriority)
    : "P2";
}

function encodePayload(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

function decodePayload(payload: string): Uint8Array {
  return new Uint8Array(Buffer.from(payload, "base64"));
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
