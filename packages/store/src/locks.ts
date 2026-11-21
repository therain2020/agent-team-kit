import { createHash } from "node:crypto";
import path from "node:path";
import { FileLockTimeoutError, acquireFileLock } from "@kit/core/fs-lock";
import type { SqlClient } from "./db";
import { appendOp } from "./op-log";

/**
 * Run `fn` while holding a Postgres advisory lock. Returns null when the lock
 * is already held by another session.
 */
export async function withAdvisoryLock<T>(
  sql: SqlClient,
  key: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const reserved = await sql.reserve();
  try {
    const rows = await reserved<
      Array<{ locked: boolean }>
    >`SELECT pg_try_advisory_lock(hashtext(${key})::bigint) AS locked`;
    if (!rows[0]?.locked) {
      return null;
    }
    try {
      return await fn();
    } finally {
      await reserved`SELECT pg_advisory_unlock(hashtext(${key})::bigint)`;
    }
  } finally {
    reserved.release?.();
  }
}

export interface LockableStore {
  driver: "postgres" | "sqlite";
  sql: SqlClient;
  config: { localDbPath: string };
}

/**
 * Cross-process single-writer lock. Postgres uses advisory locks; SQLite uses
 * a heartbeat file next to the database so the CLI, web and worker processes
 * agree without holding a write transaction for the whole critical section.
 */
export async function withStoreLock<T>(
  store: LockableStore,
  key: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (store.driver === "postgres") {
    let acquired = false;
    const result = await withAdvisoryLock(store.sql, key, async () => {
      acquired = true;
      await recordLockOp(store, key, "lock.acquired", "postgres");
      return fn();
    });
    if (!acquired) {
      await recordLockOp(store, key, "lock.contended", "postgres");
    }
    return result;
  }

  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const lockPath = path.join(
    path.dirname(store.config.localDbPath),
    "locks",
    `${digest}.lock`,
  );
  try {
    const handle = await acquireFileLock(lockPath, {
      owner: `store:${process.pid}`,
      timeoutMs: 250,
      staleMs: 15 * 60_000,
      heartbeatMs: 10_000,
      pollMs: 50,
    });
    try {
      await recordLockOp(store, key, "lock.acquired", "sqlite");
      return await fn();
    } finally {
      handle.release();
    }
  } catch (error) {
    if (error instanceof FileLockTimeoutError) {
      await recordLockOp(store, key, "lock.contended", "sqlite");
      return null;
    }
    throw error;
  }
}

/**
 * Appends single-writer lock evidence to the unified op log (85 §5.2 S9).
 * Audit must never break the critical section, so failures are logged only.
 * The gate collector reads `lock.*` ops as concurrency/serialization evidence.
 */
async function recordLockOp(
  store: LockableStore,
  key: string,
  op: "lock.acquired" | "lock.contended",
  driver: "postgres" | "sqlite",
): Promise<void> {
  try {
    await appendOp(
      { sql: store.sql },
      {
        workspaceId: "default",
        entityKind: "store_lock",
        entityId: key.slice(0, 200),
        op,
        actor: `store:${process.pid}`,
        origin: "system",
        payload: { key: key.slice(0, 200), driver },
      },
    );
  } catch (error) {
    console.error(
      `[store] failed to audit ${op} for ${key}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
