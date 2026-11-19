import { CliError } from "@kit/core";
import {
  type ApprovalStatus,
  type WorldSnapshotResult,
  initStore,
  loadWorldSnapshot,
} from "@kit/store";
import type { Command } from "commander";
import { decideApprovalEntity } from "../agent-approvals";
import { streamWorldDeltas } from "../agent-watch";
import { emit, emitError, printJsonLine, wantsJson } from "../output";

/**
 * `kit agent` — the headless command surface for the console's world,
 * approvals and stream. Every leaf speaks the #143 machine contract: one JSON
 * envelope under `--json`, stable error codes, and a resumable cursor where the
 * command streams.
 *
 * Agent usage (one-liners):
 *   kit agent world --json                      snapshot runs + agent states
 *   kit agent approvals --json                  queued approvals, sorted by due
 *   kit agent approvals decide <id> --approve --reason ok --json
 *   kit agent watch --after <seq> --json        NDJSON world deltas, resumable
 *
 * Exit codes: 0 ok · 2 usage · 3 not_found · 4 conflict · 7 dependency_unavailable.
 */
export function registerAgent(program: Command): void {
  const agent = program
    .command("agent")
    .description("Headless world, approvals and stream for agents")
    .addHelpText(
      "after",
      [
        "",
        "Agent usage:",
        "  kit agent world --json                     world snapshot (same contract as /api/world)",
        "  kit agent approvals --json                 list queued approvals",
        "  kit agent approvals decide <id> --approve|--reject --reason <text> --json",
        "  kit agent watch --after <seq> --json       NDJSON world deltas (Ctrl-C to stop)",
        "",
        "Exit codes: 0 ok, 2 usage, 3 not_found, 4 conflict, 7 dependency_unavailable.",
      ].join("\n"),
    );

  registerAgentWorld(agent);
  registerAgentApprovals(agent);
  registerAgentWatch(agent);
}

function registerAgentWorld(parent: Command): void {
  parent
    .command("world")
    .description(
      "Print the world snapshot: runs, current stage, cost and blocked reason",
    )
    .option(
      "--since <seq>",
      "only runs materialized after this activity cursor",
    )
    .option("--limit <n>", "maximum runs to include")
    .option("--workspace <id>", "workspace id", "default")
    .option("--json", "machine-readable output", false)
    .addHelpText(
      "after",
      [
        "",
        "Agent usage:",
        "  kit agent world --json                 full snapshot + seq",
        "  kit agent world --since 42 --json      only runs changed after seq 42",
        "",
        "The payload matches GET /api/world exactly: { snapshot, seq, etag }.",
        "Resume `kit agent watch --after <seq>` from the snapshot's seq.",
      ].join("\n"),
    )
    .action(async (options: Record<string, unknown>) => {
      const json = wantsJson(options);
      let store: Awaited<ReturnType<typeof initStore>>;
      try {
        store = await initStore();
      } catch (error) {
        emitError(json, openStoreError(error));
        return;
      }
      try {
        const since =
          options.since === undefined
            ? undefined
            : parseInteger(options.since, "--since");
        const limit =
          options.limit === undefined
            ? undefined
            : parseInteger(options.limit, "--limit");
        const workspaceId = pickString(options.workspace) ?? "default";
        const result = await loadWorldSnapshot(store, {
          workspaceId,
          ...(since !== undefined ? { since } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        emit(json, result, () => renderWorld(result));
      } catch (error) {
        emitError(json, error);
      } finally {
        await store.close();
      }
    });
}

function registerAgentApprovals(parent: Command): void {
  const approvals = parent
    .command("approvals")
    .description("List approvals; `decide` performs a compare-and-set decision")
    .option(
      "--status <status>",
      "queued | approved | rejected | expired | all",
      "queued",
    )
    .option("--sort <sort>", "due | created", "due")
    .option("--cursor <cursor>", "opaque cursor from a previous page")
    .option("--limit <n>", "page size (1-200)", "50")
    .option("--workspace <id>", "workspace id")
    .option("--json", "machine-readable output", false)
    .addHelpText(
      "after",
      [
        "",
        "Agent usage:",
        "  kit agent approvals --json                 queued, sorted by due",
        "  kit agent approvals --status all --json    every status for audit",
        "  kit agent approvals --cursor <c> --json     next page",
        "",
        "Exit codes: 0 ok, 2 usage, 7 dependency_unavailable.",
      ].join("\n"),
    )
    .action(async (options: Record<string, unknown>) => {
      const json = wantsJson(options);
      let store: Awaited<ReturnType<typeof initStore>>;
      try {
        store = await initStore();
      } catch (error) {
        emitError(json, openStoreError(error));
        return;
      }
      try {
        const status = parseStatus(options.status);
        const sort = parseSort(options.sort);
        const limit = parseInteger(options.limit ?? "50", "--limit");
        const page = await store.approvals.list({
          status,
          sort,
          cursor: pickString(options.cursor) ?? null,
          limit,
          ...(pickString(options.workspace)
            ? { workspaceId: pickString(options.workspace) }
            : {}),
        });
        const data = { approvals: page.items, nextCursor: page.nextCursor };
        emit(json, data, () => renderApprovals(data));
      } catch (error) {
        emitError(json, error);
      } finally {
        await store.close();
      }
    });

  approvals
    .command("decide <approvalId>")
    .description(
      "Approve or reject one approval with compare-and-set semantics",
    )
    .option("--approve", "approve the request", false)
    .option("--reject", "reject the request", false)
    .option("--reason <text>", "decision rationale (required)")
    .option(
      "--version <n>",
      "expected version; omit to decide on the current one",
    )
    .option("--by <actor>", "decision actor", "operator:cli:agent")
    .option(
      "--idempotency-key <key>",
      "ledger key; a retry replays the first decision instead of racing it",
    )
    .option("--json", "machine-readable output", false)
    .addHelpText(
      "after",
      [
        "",
        "Agent usage:",
        "  kit agent approvals decide <id> --approve --reason ok --json",
        '  kit agent approvals decide <id> --reject --reason "no budget" --version 3 --json',
        "  kit agent approvals decide <id> --approve --reason ok --idempotency-key <k> --json",
        "",
        "Conflict (stale version, already decided, duplicate) => error.code=conflict, exit 4.",
        "Reusing --idempotency-key after success replays the decision (duplicate=true).",
      ].join("\n"),
    )
    .action(async (approvalId: string, options: Record<string, unknown>) => {
      const json = wantsJson(options);
      const approve = options.approve === true;
      const reject = options.reject === true;
      if (approve === reject) {
        emitError(
          json,
          new CliError("usage", "pass exactly one of --approve or --reject"),
        );
        return;
      }
      const reason = pickString(options.reason);
      if (!reason) {
        emitError(json, new CliError("usage", "--reason is required"));
        return;
      }
      const expectedVersion =
        options.version === undefined
          ? undefined
          : parseInteger(options.version, "--version");

      let store: Awaited<ReturnType<typeof initStore>>;
      try {
        store = await initStore();
      } catch (error) {
        emitError(json, openStoreError(error));
        return;
      }
      try {
        const result = await decideApprovalEntity(store, {
          approvalId,
          status: approve ? "approved" : "rejected",
          decisionBy: pickString(options.by) ?? "operator:cli:agent",
          reason,
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          ...(pickString(options.idempotencyKey)
            ? { idempotencyKey: pickString(options.idempotencyKey) }
            : {}),
        });
        emit(json, result, () => renderDecision(result));
      } catch (error) {
        emitError(json, error);
      } finally {
        await store.close();
      }
    });
}

interface AgentWatchOptions {
  after?: string;
  url?: string;
  once?: boolean;
  maxReconnects?: string;
  json?: boolean;
}

function registerAgentWatch(parent: Command): void {
  parent
    .command("watch")
    .description(
      "Stream world deltas from /api/world/stream, resuming from --after <seq>",
    )
    .option("--after <seq>", "resume after this activity cursor", "0")
    .option(
      "--url <origin>",
      "console origin (default: KIT_WEB_URL or http://localhost:3000)",
    )
    .option(
      "--once",
      "stop after the first delta (non-blocking test/one-shot)",
      false,
    )
    .option(
      "--max-reconnects <n>",
      "reconnect attempts before failing (-1 = forever)",
      "-1",
    )
    .option("--json", "print NDJSON envelopes", false)
    .addHelpText(
      "after",
      [
        "",
        "Agent usage:",
        "  kit agent watch --after 0 --json            tail world deltas",
        "  kit agent watch --after 0 --json --once     one delta, then exit",
        "",
        "Disconnect recovery: every line's data.seq is the next cursor. If the",
        "stream drops, resume with --after <last seq>; the console replays history",
        "from activity_events first, then continues live. Ctrl-C exits cleanly.",
        "Nothing is lost or duplicated across reconnects: the cursor is exclusive.",
      ].join("\n"),
    )
    .action(async (options: AgentWatchOptions) => {
      const json = wantsJson(options);
      const after = parseInteger(options.after ?? "0", "--after");
      const baseUrl =
        pickString(options.url) ??
        process.env.KIT_WEB_URL ??
        "http://localhost:3000";
      const configured = parseInteger(
        options.maxReconnects ?? "-1",
        "--max-reconnects",
        true,
      );
      // A one-shot read should fail instead of retrying a dead console forever.
      const maxReconnects =
        options.once === true && configured < 0 ? 3 : configured;

      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);

      try {
        await streamWorldDeltas({
          baseUrl,
          after,
          signal: controller.signal,
          ...(options.once === true ? { maxEvents: 1 } : {}),
          maxReconnects,
          onDelta: (delta) => {
            if (json) {
              printJsonLine(delta);
            } else {
              console.log(formatWorldDelta(delta));
            }
          },
        });
      } catch (error) {
        if (error instanceof CliError) {
          emitError(json, error);
          return;
        }
        emitError(
          json,
          new CliError(
            "dependency_unavailable",
            `cannot reach the world stream at ${baseUrl}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            {
              hint: "start the console with `kit up --web`, or pass --url <origin>",
              cause: error,
            },
          ),
        );
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    });
}

function openStoreError(error: unknown): CliError {
  return new CliError(
    "dependency_unavailable",
    "cannot reach the kit database",
    {
      hint: "start the stack with `kit up`, or point KIT_DB_URL at a running Postgres",
      details: {
        detail: error instanceof Error ? error.message : String(error),
      },
      cause: error,
    },
  );
}

function parseInteger(
  value: unknown,
  flag: string,
  allowNegative = false,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const min = allowNegative ? -1 : 0;
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new CliError(
      "usage",
      `${flag} must be ${allowNegative ? "an integer >= -1" : "a non-negative integer"}`,
    );
  }
  return Math.trunc(parsed);
}

function parseStatus(value: unknown): ApprovalStatus | undefined {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "all"
  ) {
    return undefined;
  }
  if (
    value === "queued" ||
    value === "approved" ||
    value === "rejected" ||
    value === "expired"
  ) {
    return value;
  }
  throw new CliError(
    "usage",
    "--status must be queued | approved | rejected | expired | all",
  );
}

function parseSort(value: unknown): "due" | "created" {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "due"
  ) {
    return "due";
  }
  if (value === "created") {
    return "created";
  }
  throw new CliError("usage", "--sort must be due | created");
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function renderWorld(result: WorldSnapshotResult): void {
  const runs = result.snapshot.runs;
  if (runs.length === 0) {
    console.log("no runs");
  } else {
    for (const run of runs) {
      const parts = [
        run.runId.padEnd(20),
        run.status.padEnd(9),
        `stage=${run.currentStage ?? "-"}`,
        `${Math.round(run.progress * 100)}%`,
        `¥${run.costCny.toFixed(2)}`,
      ];
      if (run.waitReason) {
        parts.push(`wait=${run.waitReason}`);
      }
      console.log(parts.join("  "));
    }
  }
  console.log(`seq ${result.seq}  agents ${result.snapshot.agents.length}`);
}

function renderApprovals(data: {
  approvals: Array<{
    approvalId: string;
    status: string;
    runId: string;
    stageName: string | null;
    stageId: string | null;
    version: number;
    slaDueAt: string | null;
    expiresAt: string | null;
  }>;
  nextCursor: string | null;
}): void {
  if (data.approvals.length === 0) {
    console.log("no approvals");
  } else {
    for (const item of data.approvals) {
      console.log(
        [
          item.approvalId,
          item.status.padEnd(8),
          item.runId,
          item.stageName ?? item.stageId ?? "-",
          `v${item.version}`,
          `due=${item.slaDueAt ?? item.expiresAt ?? "-"}`,
        ].join("  "),
      );
    }
  }
  if (data.nextCursor) {
    console.log(`next: ${data.nextCursor}`);
  }
}

function renderDecision(result: {
  approvalId: string;
  status: string;
  version: number;
  duplicate: boolean;
}): void {
  console.log(
    `${result.approvalId}  ${result.status}  v${result.version}${
      result.duplicate ? "  (idempotent replay)" : ""
    }`,
  );
}

function formatWorldDelta(delta: unknown): string {
  const value =
    delta && typeof delta === "object"
      ? (delta as {
          seq?: unknown;
          runs?: unknown[];
          agents?: unknown[];
          eventCount?: unknown;
        })
      : {};
  const runs = Array.isArray(value.runs) ? value.runs.length : 0;
  const agents = Array.isArray(value.agents) ? value.agents.length : 0;
  return `seq ${value.seq ?? "?"}  runs ${runs}  agents ${agents}  events ${value.eventCount ?? "?"}`;
}
