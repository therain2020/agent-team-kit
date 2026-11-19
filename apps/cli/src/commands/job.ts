import path from "node:path";
import { CliError } from "@kit/core";
import { closeIterationStore, startLocalRunner } from "@kit/engine";
import {
  JobError,
  type JobKind,
  abortJob,
  applyPendingChange,
  getJob,
  listJobs,
  listPendingChanges,
  startJob,
} from "@kit/job";
import { initStore } from "@kit/store";
import { createTemporalClient } from "@kit/workflow";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

export interface StartIterationOptions {
  goal: string;
  acceptance?: string;
  domain?: string;
  pack?: string;
  maxTasks?: string;
  maxRepair?: string;
  coder?: string;
  apply?: string;
  live?: boolean;
  stub?: boolean;
  budgetCny?: string;
  dedupeKey?: string;
  idempotencyKey?: string;
  json?: boolean;
  wait?: boolean;
}

export function registerJob(program: Command): void {
  const job = program.command("job").description("Start and control jobs");

  job
    .command("start")
    .description("Start a pack run or an iteration")
    .requiredOption("--pack <dir>", "pack directory")
    .option("--kind <kind>", "pack-run | iteration", "pack-run")
    .option("--goal <text>", "goal (required for iteration)")
    .option("--acceptance <text>", "acceptance criteria")
    .option("--workflow <id>", "workflow id for pack-run")
    .option("--domain <name>", "iteration domain")
    .option("--input <text>", "initial input for pack-run")
    .option("--max-tasks <n>", "maximum tasks to plan", "4")
    .option(
      "--max-repair <n>",
      "repair attempts per task (default: KIT_REPAIR_ROUNDS or 2)",
    )
    .option("--coder <id>", "dsh | codex | opencode | command")
    .option("--apply <mode>", "none | low | low-medium", "low")
    .option("--live", "run in LIVE mode (otherwise DRY_RUN)", false)
    .option("--stub", "use the deterministic planner", false)
    .option("--budget-cny <n>", "optional iteration budget")
    .option("--dedupe-key <key>", "attach to an existing run")
    .option(
      "--idempotency-key <key>",
      "alias for --dedupe-key on iterations (no ledger for pack runs yet)",
    )
    .option("--no-wait", "return immediately instead of waiting for the result")
    .option("--json", "machine-readable output", false)
    .action(async (options: Record<string, unknown>) => {
      const json = wantsJson(options);
      const kind = parseKind(options.kind);
      if (!kind) {
        emitError(
          json,
          new CliError("usage", "--kind must be pack-run or iteration"),
        );
        return;
      }
      const dedupeKey = pickString(options.dedupeKey ?? options.idempotencyKey);
      const store = await initStore();
      try {
        const result = await startJob(
          store,
          {
            kind,
            packDir: String(options.pack),
            origin: "cli",
            runMode: options.live === true ? "LIVE" : "DRY_RUN",
            goal: typeof options.goal === "string" ? options.goal : undefined,
            acceptance:
              typeof options.acceptance === "string"
                ? options.acceptance
                : undefined,
            workflow:
              typeof options.workflow === "string"
                ? options.workflow
                : undefined,
            domain:
              typeof options.domain === "string" ? options.domain : undefined,
            applyMode:
              kind === "iteration" && options.live === true
                ? parseApplyMode(options.apply)
                : undefined,
            maxTasks: options.maxTasks ? Number(options.maxTasks) : undefined,
            maxRepair: options.maxRepair
              ? Number(options.maxRepair)
              : undefined,
            coder:
              typeof options.coder === "string"
                ? (options.coder as "dsh" | "codex" | "opencode" | "command")
                : undefined,
            stub: options.stub === true,
            budgetCny:
              options.budgetCny !== undefined
                ? Number(options.budgetCny)
                : undefined,
            dedupeKey,
            evidenceText:
              typeof options.input === "string" ? options.input : undefined,
          },
          { repoRoot: path.resolve(process.cwd()) },
        );
        const startData = {
          jobId: result.jobId,
          kind: result.kind,
          workflowId: result.workflowId,
          runMode: result.runMode,
          ...(result.applyMode ? { applyMode: result.applyMode } : {}),
          pack: result.pack,
          ...(result.workflow ? { workflow: result.workflow } : {}),
          engine: result.engine,
          ...(result.requestId ? { requestId: result.requestId } : {}),
          ...(dedupeKey ? { dedupeKey } : {}),
          ...(result.engine === "temporal"
            ? { temporalUi: "http://localhost:8080" }
            : {}),
        };
        const renderStart = () => {
          console.log(JSON.stringify(startData, null, 2));
        };

        if (options.wait === false) {
          emit(json, startData, renderStart);
          return;
        }
        if (result.engine === "local") {
          if (result.kind === "iteration") {
            const final = await waitForLocalJob(
              store,
              "iteration",
              result.jobId,
              !json,
            );
            emitJobResult(json, { ...startData, final }, renderStart);
          } else {
            emit(json, startData, renderStart);
          }
          return;
        }
        const final = await waitForJob(
          result.kind,
          result.jobId,
          result.workflowId,
          !json,
        );
        emitJobResult(json, { ...startData, final }, renderStart);
      } catch (error) {
        printJobError(error, json);
      } finally {
        await store.close();
      }
    });

  job
    .command("list")
    .description("List recent jobs")
    .option("--kind <kind>", "pack-run | iteration")
    .option("--status <status>", "filter by status")
    .option("--limit <n>", "maximum jobs", "20")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        kind?: string;
        status?: string;
        limit?: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        const store = await initStore();
        try {
          const kind = options.kind ? parseKind(options.kind) : undefined;
          const jobs = await listJobs(store, {
            ...(kind ? { kind } : {}),
            ...(options.status ? { status: options.status } : {}),
            limit: Number(options.limit ?? 20),
          });
          emit(json, { jobs }, () => {
            if (jobs.length === 0) {
              console.log("No jobs yet.");
              return;
            }
            for (const item of jobs) {
              console.log(
                [
                  item.kind.padEnd(9),
                  item.status.padEnd(9),
                  item.jobId,
                  item.goal ?? "",
                ]
                  .join("  ")
                  .trim(),
              );
            }
          });
        } catch (error) {
          printJobError(error, json);
        } finally {
          await store.close();
        }
      },
    );

  job
    .command("show <jobId>")
    .description("Show a job summary")
    .option("--kind <kind>", "pack-run | iteration")
    .option("--json", "machine-readable output", false)
    .action(
      async (jobId: string, options: { kind?: string; json?: boolean }) => {
        const json = wantsJson(options);
        const store = await initStore();
        try {
          const kinds: JobKind[] = options.kind
            ? [parseKind(options.kind) ?? "iteration"]
            : ["iteration", "packRun"];
          for (const kind of kinds) {
            const found = await getJob(store, kind, jobId);
            if (found) {
              emit(json, found, () => {
                console.log(JSON.stringify(found, null, 2));
              });
              return;
            }
          }
          emitError(json, new CliError("not_found", "job not found"));
        } catch (error) {
          printJobError(error, json);
        } finally {
          await store.close();
        }
      },
    );

  job
    .command("abort <jobId>")
    .description("Abort a running job")
    .requiredOption("--kind <kind>", "pack-run | iteration")
    .option("--json", "machine-readable output", false)
    .action(
      async (jobId: string, options: { kind: string; json?: boolean }) => {
        const json = wantsJson(options);
        const kind = parseKind(options.kind);
        if (!kind) {
          emitError(
            json,
            new CliError("usage", "--kind must be pack-run or iteration"),
          );
          return;
        }
        const store = await initStore();
        try {
          const result = await abortJob(store, kind, jobId, {
            repoRoot: path.resolve(process.cwd()),
          });
          emit(json, result, () => {
            console.log(JSON.stringify(result, null, 2));
          });
        } catch (error) {
          printJobError(error, json);
        } finally {
          await store.close();
        }
      },
    );

  job
    .command("changes [jobId]")
    .description("List pending changes that require manual apply")
    .option("--json", "machine-readable output", false)
    .action(async (jobId: string | undefined, options: { json?: boolean }) => {
      const json = wantsJson(options);
      const store = await initStore();
      try {
        const changes = await listPendingChanges(store, jobId);
        emit(json, { changes }, () => {
          if (changes.length === 0) {
            console.log("No pending changes.");
            return;
          }
          console.log(JSON.stringify(changes, null, 2));
        });
      } catch (error) {
        printJobError(error, json);
      } finally {
        await store.close();
      }
    });

  job
    .command("apply <ticketId>")
    .description("Apply a pending change (requires a note)")
    .requiredOption("--note <text>", "reason for applying")
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (
        ticketId: string,
        options: { note: string; idempotencyKey?: string; json?: boolean },
      ) => {
        const json = wantsJson(options);
        const store = await initStore();
        try {
          const result = await applyPendingChange(store, ticketId, {
            actor: "operator:cli",
            note: options.note,
            repoRoot: path.resolve(process.cwd()),
          });
          emit(
            json,
            {
              ...result,
              ...(options.idempotencyKey
                ? { idempotencyKey: options.idempotencyKey }
                : {}),
            },
            () => {
              console.log(JSON.stringify(result, null, 2));
            },
          );
        } catch (error) {
          printJobError(error, json);
        } finally {
          await store.close();
        }
      },
    );
}

export async function startIterationFromCli(
  options: StartIterationOptions,
): Promise<void> {
  const json = wantsJson(options);
  const dedupeKey = pickString(options.dedupeKey ?? options.idempotencyKey);
  const store = await initStore();
  try {
    const result = await startJob(
      store,
      {
        kind: "iteration",
        packDir: options.pack ?? "packs/self-improve",
        origin: "cli",
        runMode: options.live === true ? "LIVE" : "DRY_RUN",
        goal: options.goal,
        acceptance: options.acceptance,
        domain: options.domain,
        applyMode:
          options.live === true
            ? (parseApplyMode(options.apply) ?? "low")
            : "none",
        maxTasks: options.maxTasks ? Number(options.maxTasks) : 4,
        maxRepair: options.maxRepair ? Number(options.maxRepair) : undefined,
        coder:
          options.coder === "dsh" ||
          options.coder === "codex" ||
          options.coder === "opencode" ||
          options.coder === "command"
            ? options.coder
            : undefined,
        stub: options.stub === true,
        budgetCny:
          options.budgetCny !== undefined
            ? Number(options.budgetCny)
            : undefined,
        dedupeKey,
      },
      { repoRoot: path.resolve(process.cwd()) },
    );
    const startData = {
      iterationId: result.jobId,
      workflowId: result.workflowId,
      runMode: result.runMode,
      applyMode: result.applyMode,
      pack: result.pack,
      engine: result.engine,
      ...(dedupeKey ? { dedupeKey } : {}),
      ...(result.requestId ? { requestId: result.requestId } : {}),
      ...(result.engine === "temporal"
        ? { temporalUi: "http://localhost:8080" }
        : {}),
    };
    const renderStart = () => {
      console.log(JSON.stringify(startData, null, 2));
    };
    if (options.wait === false) {
      emit(json, startData, renderStart);
      return;
    }
    if (result.engine === "local") {
      const final = await waitForLocalJob(
        store,
        "iteration",
        result.jobId,
        !json,
      );
      emitJobResult(json, { ...startData, final }, renderStart);
      return;
    }
    const final = await waitForJob(
      "iteration",
      result.jobId,
      result.workflowId,
      !json,
    );
    emitJobResult(json, { ...startData, final }, renderStart);
  } catch (error) {
    printJobError(error, json);
  } finally {
    await store.close();
  }
}

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "completed",
]);

interface LocalJobOutcome {
  ok: boolean;
  job?: unknown;
  requestStatus?: string;
  error?: unknown;
  exitCode?: number;
}

/**
 * Local mode has no workflow handle to await. Run the queue in this process
 * (another runner may exist; the claim makes that safe) and poll SQLite.
 */
async function waitForLocalJob(
  store: Awaited<ReturnType<typeof initStore>>,
  kind: JobKind,
  jobId: string,
  humanProgress: boolean,
): Promise<LocalJobOutcome> {
  const stop = startLocalRunner({ store, tickMs: 250 });
  try {
    for (;;) {
      const job = await getJob(store, kind, jobId);
      if (job && TERMINAL_STATUSES.has(job.status)) {
        const ok = job.status !== "failed" && job.status !== "cancelled";
        if (humanProgress) {
          console.log(JSON.stringify(job, null, 2));
          if (!ok) {
            process.exitCode = 1;
          }
        }
        return { ok, job };
      }
      // A request can fail before the run row is finalized (bad payload, queue
      // error); surface that instead of polling forever.
      const request = await store.runRequests.find(jobId);
      if (
        request &&
        (request.status === "failed" || request.status === "cancelled")
      ) {
        const outcome: LocalJobOutcome = {
          ok: false,
          job: {
            jobId,
            kind,
            status: job?.status ?? "unknown",
            phase: job?.phase ?? null,
            requestStatus: request.status,
            error: request.error,
          },
          requestStatus: request.status,
          error: request.error,
        };
        if (humanProgress) {
          console.log(JSON.stringify(outcome.job, null, 2));
          process.exitCode = 1;
        }
        return outcome;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    stop();
    await closeIterationStore();
  }
}

async function waitForJob(
  kind: JobKind,
  jobId: string,
  workflowId: string,
  humanProgress: boolean,
): Promise<unknown> {
  const { client, connection } = await createTemporalClient();
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const handle = client.workflow.getHandle(workflowId);
    if (humanProgress) {
      timer = setInterval(() => {
        void (async () => {
          try {
            const description = await handle.describe();
            console.log(
              `[job] ${kind} ${jobId} status=${description.status.name}`,
            );
          } catch {
            // workflow may be closing
          }
        })();
      }, 15_000);
    }
    const result = await handle.result();
    if (humanProgress) {
      console.log(JSON.stringify(result, null, 2));
    }
    return result;
  } catch (error) {
    throw new CliError(
      "internal",
      `job failed: ${error instanceof Error ? error.message : String(error)}`,
      { details: { kind, jobId, workflowId } },
    );
  } finally {
    if (timer) {
      clearInterval(timer);
    }
    await connection.close();
  }
}

function emitJobResult(
  json: boolean,
  data: Record<string, unknown> & { final: LocalJobOutcome | unknown },
  renderStart: () => void,
): void {
  const final = data.final as LocalJobOutcome | unknown;
  const failed =
    !!final &&
    typeof final === "object" &&
    "ok" in (final as Record<string, unknown>) &&
    (final as LocalJobOutcome).ok === false;
  if (json) {
    if (failed) {
      emitError(
        true,
        new CliError("internal", "job did not succeed", { details: data }),
      );
      return;
    }
    emit(true, data);
    return;
  }
  renderStart();
}

function parseKind(value: unknown): JobKind | null {
  if (value === "iteration") {
    return "iteration";
  }
  if (value === "pack-run" || value === "packRun") {
    return "packRun";
  }
  return null;
}

function parseApplyMode(value: unknown): "none" | "low" | "low-medium" {
  return value === "none" || value === "low" || value === "low-medium"
    ? value
    : "low";
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function printJobError(error: unknown, json: boolean): void {
  emitError(json, error, (classified) => {
    if (error instanceof JobError) {
      console.error(`✖ ${error.code}: ${error.message}`);
      return;
    }
    console.error(`✖ ${classified.message}`);
  });
}
