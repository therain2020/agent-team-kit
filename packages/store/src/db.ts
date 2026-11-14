import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import {
  type PostgresJsDatabase,
  drizzle as drizzlePostgres,
} from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { StoreConfig } from "./config";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export interface SqlRunner {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  end(): Promise<void>;
}

export interface DbHandle {
  driver: StoreConfig["driver"];
  db: Database;
  sql: SqlRunner;
  exec(statement: string): Promise<void>;
  close(): Promise<void>;
}

export function createDb(config: StoreConfig): DbHandle {
  if (config.driver === "pglite") {
    return createPglite(config.dataDir);
  }
  return createPostgres(config.dbUrl);
}

function createPostgres(url: string): DbHandle {
  const client = postgres(url, { max: 5, onnotice: () => {} });
  const db = drizzlePostgres(client, { schema });

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    client(strings, ...(values as never[]))) as unknown as SqlRunner;
  sql.end = () => client.end({ timeout: 5 });

  return {
    driver: "postgres",
    db,
    sql,
    exec: async (statement) => {
      await client.unsafe(statement);
    },
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}

function createPglite(dataDir: string): DbHandle {
  const client = new PGlite(dataDir);
  // Drizzle's query builder is driver-neutral; repository code only uses it.
  const db = drizzlePglite(client, { schema }) as unknown as Database;

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1] ?? ""}`;
    }
    const result = await client.query(text, values);
    return result.rows;
  }) as SqlRunner;
  sql.end = () => client.close();

  return {
    driver: "pglite",
    db,
    sql,
    exec: async (statement) => {
      await client.exec(statement);
    },
    close: async () => {
      await client.close();
    },
  };
}

export type SqlClient = SqlRunner;
