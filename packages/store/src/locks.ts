import { createHash } from "node:crypto";
import path from "node:path";
import { FileLockTimeoutError, acquireFileLock } from "@kit/core/fs-lock";
import type { SqlClient } from "./db";

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
    return withAdvisoryLock(store.sql, key, fn);
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
      return await fn();
    } finally {
      handle.release();
    }
  } catch (error) {
    if (error instanceof FileLockTimeoutError) {
      return null;
    }
    throw error;
  }
}
