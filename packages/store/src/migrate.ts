import type { StoreDriver } from "./config";
import { PG_SCHEMA_SQL, SQLITE_SCHEMA_SQL } from "./schema-text";

export async function ensureSchema(
  exec: (statement: string) => Promise<void>,
  driver: StoreDriver,
): Promise<void> {
  const schemaText = driver === "sqlite" ? SQLITE_SCHEMA_SQL : PG_SCHEMA_SQL;

  const statements = schemaText
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    try {
      await exec(statement);
    } catch (error) {
      if (driver === "sqlite" && /duplicate column name/i.test(String(error))) {
        // SQLite has no ADD COLUMN IF NOT EXISTS; the inline definition in
        // CREATE TABLE already created the column on fresh databases.
        continue;
      }
      throw error;
    }
  }
}
