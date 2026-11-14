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
    reserved.release();
  }
}
