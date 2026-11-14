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

export interface SqlFragment {
  readonly __kitSql: true;
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * Minimal SQL surface shared by the Postgres and SQLite drivers. Feature code
 * that needs dialect-specific SQL should go through this interface instead of
 * reaching for a driver client; the SQLite implementation translates the
 * common subset and emulates transactions on a dedicated connection.
 */
export interface SqlClient {
  <T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  begin<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  notify(channel: string, payload: string): Promise<void>;
  listen(
    channel: string,
    callback: (payload: string) => void,
  ): Promise<{ unlisten(): Promise<void> }>;
  json(value: unknown): unknown;
  reserve(): Promise<SqlClient>;
  release?(): void;
}

interface DbBase {
  sql: SqlClient;
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

  const sql = Object.assign(
    ((strings: TemplateStringsArray, ...values: unknown[]) =>
      (
        client as unknown as (
          template: TemplateStringsArray,
          ...params: unknown[]
        ) => Promise<unknown>
      )(strings, ...values)) as unknown as SqlClient,
    {
      begin: <T>(fn: (tx: SqlClient) => Promise<T>) =>
        client.begin((tx) => fn(tx as unknown as SqlClient)) as Promise<T>,
      notify: (channel: string, payload: string) =>
        client.notify(channel, payload),
      listen: (channel: string, callback: (payload: string) => void) =>
        client.listen(channel, (payload) => callback(payload)),
      json: (value: unknown) =>
        (client.json as (input: unknown) => unknown)(value),
      reserve: () => client.reserve() as unknown as Promise<SqlClient>,
    },
  );

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
    ping: async () => {
      await client`select 1`;
    },
  };
}

type SqliteConnection = InstanceType<typeof SqliteClient>;

function createSqlite(file: string): DbHandle {
  mkdirSync(path.dirname(file), { recursive: true });
  const client = new SqliteClient(file);
  const txClient = new SqliteClient(file);
  for (const connection of [client, txClient]) {
    connection.pragma("journal_mode = WAL");
    connection.pragma("busy_timeout = 5000");
    connection.pragma("foreign_keys = ON");
    connection.function("greatest", { varargs: true }, (...args: unknown[]) =>
      Math.max(...args.map(Number)),
    );
    connection.function("least", { varargs: true }, (...args: unknown[]) =>
      Math.min(...args.map(Number)),
    );
  }
  const db = drizzleSqlite(client, { schema: sqliteSchema });
  const mainSql = createSqliteTag(client);
  const txSql = Object.assign(createSqliteTag(txClient), {
    begin: async (): Promise<never> => {
      throw new Error("nested SQLite transactions are not supported");
    },
    notify: async () => undefined,
    listen: sqliteListen,
    json: sqliteJson,
    reserve: sqliteReserve,
  }) as SqlClient;
  let txQueue: Promise<unknown> = Promise.resolve();

  const begin = <T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      txClient.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(txSql);
        txClient.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          txClient.exec("ROLLBACK");
        } catch {
          // The transaction may already be rolled back by SQLite.
        }
        throw error;
      }
    };
    const next = txQueue.then(run, run);
    txQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const sql = Object.assign(mainSql, {
    begin,
    notify: async () => undefined,
    listen: sqliteListen,
    json: sqliteJson,
    reserve: sqliteReserve,
  });

  return {
    driver: "sqlite",
    db,
    sql,
    exec: async (statement) => {
      client.exec(statement);
    },
    close: async () => {
      txClient.close();
      client.close();
    },
    ping: async () => {
      client.prepare("select 1").get();
    },
  };
}

function createSqliteTag(client: SqliteConnection): SqlClient {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const { text, values: params } = buildSqliteQuery(strings, values);
    const execute = () =>
      Promise.resolve().then(() => {
        const statement = client.prepare(text);
        if (!statement.reader) {
          statement.run(...params);
          return [];
        }
        return statement.all(...params);
      });
    // A lazy thenable that is also a SQL fragment: nested tags inline their
    // text instead of executing, while an awaited tag runs the statement.
    return {
      __kitSql: true,
      text,
      values: params,
      // biome-ignore lint/suspicious/noThenProperty: lazy thenable used as a SQL fragment
      then: (
        onFulfilled?: ((value: unknown) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ) => execute().then(onFulfilled, onRejected),
      catch: (onRejected?: ((reason: unknown) => unknown) | null) =>
        execute().catch(onRejected),
      finally: (onFinally?: (() => void) | null) =>
        execute().finally(onFinally),
      [Symbol.toStringTag]: "Promise",
    } as unknown as SqlClient;
  }) as unknown as SqlClient;
}

function buildSqliteQuery(
  strings: TemplateStringsArray,
  values: readonly unknown[],
): { text: string; values: unknown[] } {
  let text = "";
  const params: unknown[] = [];
  strings.forEach((part, index) => {
    text += part;
    if (index >= values.length) {
      return;
    }
    const value = values[index];
    if (isSqlFragment(value)) {
      text += value.text;
      params.push(...value.values);
      return;
    }
    text += "?";
    params.push(toSqliteValue(value));
  });
  return { text, values: params };
}

const sqliteJson = (value: unknown) => JSON.stringify(value);

const sqliteListen = async (): Promise<{ unlisten(): Promise<void> }> => {
  throw new Error(
    "SQLite does not support LISTEN/NOTIFY; poll the event cursor instead",
  );
};

const sqliteReserve = async (): Promise<SqlClient> => {
  throw new Error("SQLite does not support reserved Postgres sessions");
};

function isSqlFragment(value: unknown): value is SqlFragment {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __kitSql?: unknown }).__kitSql === true
  );
}

function toSqliteValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return value;
}

export type StoreDriverName = StoreDriver;
