import { mkdirSync } from "node:fs";
import path from "node:path";
import SqliteClient from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import {
  type PostgresJsDatabase,
  drizzle as drizzlePostgres,
} from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { StoreConfig, StoreDriver } from "./config";
import type { SqliteDatabase } from "./repositories.sqlite";
import * as pgSchema from "./schema";
import * as sqliteSchema from "./schema.sqlite";

export type Database = PostgresJsDatabase<typeof pgSchema>;
export type { SqliteDatabase };

interface DbBase {
  exec(statement: string): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<void>;
}

export type DbHandle =
  | (DbBase & { driver: "postgres"; db: Database })
  | (DbBase & { driver: "sqlite"; db: SqliteDatabase });

export function createDb(config: StoreConfig): DbHandle {
  return config.driver === "sqlite"
    ? createSqlite(config.localDbPath)
    : createPostgres(config.dbUrl);
}

function createPostgres(url: string): DbHandle {
  const client = postgres(url, { max: 5, onnotice: () => {} });
  const db = drizzlePostgres(client, { schema: pgSchema });

  return {
    driver: "postgres",
    db,
    exec: async (statement) => {
      await client.unsafe(statement);
    },
    close: async () => {
      await client.end({ timeout: 5 });
    },
    ping: async () => {
      await client`select 1`;
    },
  };
}

function createSqlite(file: string): DbHandle {
  mkdirSync(path.dirname(file), { recursive: true });
  const client = new SqliteClient(file);
  client.pragma("journal_mode = WAL");
  client.pragma("busy_timeout = 5000");
  client.pragma("foreign_keys = ON");
  const db = drizzleSqlite(client, { schema: sqliteSchema });

  return {
    driver: "sqlite",
    db,
    exec: async (statement) => {
      client.exec(statement);
    },
    close: async () => {
      client.close();
    },
    ping: async () => {
      client.prepare("select 1").get();
    },
  };
}

export type StoreDriverName = StoreDriver;
