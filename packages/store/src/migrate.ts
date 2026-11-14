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
    await exec(statement);
  }
}
