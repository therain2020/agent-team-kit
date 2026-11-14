import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function ensureSchema(
  exec: (statement: string) => Promise<void>,
): Promise<void> {
  const schemaPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "schema.sql",
  );
  const schemaText = await readFile(schemaPath, "utf8");

  const statements = schemaText
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await exec(statement);
  }
}
