import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CliError } from "@kit/core";
import {
  type EventRetentionReport,
  initStore,
  pruneEventRetention,
} from "@kit/store";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

export function registerEvent(program: Command): void {
  const event = program
    .command("event")
    .description("Event gateway operations");

  event
    .command("emit")
    .description("Sign and POST a generic event to the gateway")
    .requiredOption("--type <type>", "canonical event type")
    .option("--payload <json>", "payload JSON", "{}")
    .option("--payload-file <path>", "read payload from a file")
    .option(
      "--url <url>",
      "gateway ingest URL",
      process.env.KIT_GATEWAY_URL ?? "http://127.0.0.1:8787/ingest/generic",
    )
    .option(
      "--secret-env <name>",
      "environment variable holding the HMAC secret",
      "KIT_EVENT_SECRET",
    )
    .option(
      "--idempotency-key <key>",
      "event idempotency key (default: generated from type and timestamp)",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        type: string;
        payload: string;
        payloadFile?: string;
        url: string;
        secretEnv: string;
        idempotencyKey?: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        const secret = process.env[options.secretEnv];
        if (!secret) {
          emitError(
            json,
            new CliError(
              "dependency_unavailable",
              `${options.secretEnv} is not set`,
              {
                hint: `export ${options.secretEnv}=<hmac secret>`,
              },
            ),
          );
          return;
        }

        let payload: unknown;
        try {
          const raw = options.payloadFile
            ? await readFile(options.payloadFile, "utf8")
            : options.payload;
          const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
          payload = JSON.parse(clean);
        } catch (error) {
          emitError(
            json,
            new CliError(
              "usage",
              `invalid payload: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          return;
        }

        const idempotencyKey =
          options.idempotencyKey ?? `cli:${options.type}:${Date.now()}`;
        const body = JSON.stringify({
          type: options.type,
          payload,
          occurredAt: new Date().toISOString(),
          idempotencyKey,
        });
        const signature = `sha256=${createHmac("sha256", secret)
          .update(body)
          .digest("hex")}`;

        try {
          const response = await fetch(options.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-kit-signature": signature,
              "x-kit-timestamp": Date.now().toString(),
            },
            body,
          });
          const text = await response.text();
          const data = {
            url: options.url,
            type: options.type,
            status: response.status,
            ok: response.ok,
            idempotencyKey,
            body: text,
          };
          if (!response.ok) {
            emitError(
              json,
              new CliError(
                statusToCode(response.status),
                `gateway responded ${response.status}`,
                { details: { response: text, status: response.status } },
              ),
              (classified) => {
                console.log(`${response.status} ${text}`);
                console.error(`✖ ${classified.message}`);
              },
            );
            return;
          }
          emit(json, data, () => {
            console.log(`${response.status} ${text}`);
          });
        } catch (error) {
          emitError(
            json,
            new CliError(
              "dependency_unavailable",
              `gateway unreachable: ${error instanceof Error ? error.message : String(error)}`,
              {
                hint: `check ${options.url} or start the gateway with \`kit up\``,
              },
            ),
          );
        }
      },
    );

  event
    .command("prune")
    .description(
      "Delete activity and iteration events older than the retention window (default 90 days)",
    )
    .option("--days <n>", "retention window in days", "90")
    .option("--batch-size <n>", "rows deleted per statement", "1000")
    .option("--max-rows <n>", "maximum rows deleted per call", "100000")
    .option("--dry-run", "report eligible rows without deleting", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        days?: string;
        batchSize?: string;
        maxRows?: string;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        const retentionDays = parsePositiveInteger(options.days, 90, "--days");
        const batchSize = parsePositiveInteger(
          options.batchSize,
          1000,
          "--batch-size",
        );
        const maxRowsPerCall = parsePositiveInteger(
          options.maxRows,
          100000,
          "--max-rows",
        );

        let store: Awaited<ReturnType<typeof initStore>>;
        try {
          store = await initStore();
        } catch (error) {
          emitError(
            json,
            new CliError(
              "dependency_unavailable",
              "cannot reach the kit database",
              {
                hint: "start the stack with `kit up`, or point KIT_DB_URL at a running Postgres",
                cause: error,
              },
            ),
          );
          return;
        }

        try {
          const report = await pruneEventRetention(store, {
            retentionDays,
            batchSize,
            maxRowsPerCall,
            dryRun: options.dryRun === true,
          });
          emit(json, report, () => {
            renderPruneReport(report);
          });
        } catch (error) {
          emitError(json, error);
        } finally {
          await store.close();
        }
      },
    );
}

function renderPruneReport(report: EventRetentionReport): void {
  const windowLabel = `${report.retentionDays}-day retention`;
  if (report.dryRun) {
    console.log(
      `dry-run: ${report.eligible} event(s) older than ${report.cutoff} would be pruned (${windowLabel})`,
    );
  } else {
    console.log(
      `pruned ${report.deleted} event(s) older than ${report.cutoff} (${windowLabel})`,
    );
  }
  for (const table of report.tables) {
    const count = report.dryRun ? table.eligible : table.deleted;
    const range =
      table.oldest && table.newest
        ? `${table.oldest} .. ${table.newest}`
        : "no rows";
    console.log(`  ${table.table}  ${count} rows  ${range}`);
  }
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  flag: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError("usage", `${flag} must be a positive integer`);
  }
  return parsed;
}

function statusToCode(status: number) {
  if (status === 401 || status === 403) {
    return "permission" as const;
  }
  if (status === 404) {
    return "not_found" as const;
  }
  if (status === 409) {
    return "conflict" as const;
  }
  if (status === 429) {
    return "budget" as const;
  }
  if (status >= 400 && status < 500) {
    return "usage" as const;
  }
  return "dependency_unavailable" as const;
}
