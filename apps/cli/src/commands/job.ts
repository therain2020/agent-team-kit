import path from "node:path";
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
    .option("--max-repair <n>", "repair attempts per task", "2")
    .option("--coder <id>", "dsh | codex | opencode | command")
    .option("--apply <mode>", "none | low | low-medium", "low")
    .option("--live", "run in LIVE mode (otherwise DRY_RUN)", false)
    .option("--stub", "use the deterministic planner", false)
    .option("--budget-cny <n>", "optional iteration budget")
    .option("--dedupe-key <key>", "attach to an existing run")
    .option("--no-wait", "return immediately instead of waiting for the result")
    .action(async (options: Record<string, unknown>) => {
      const kind = parseKind(options.kind);
      if (!kind) {
        console.error("✖ --kind must be pack-run or iteration");
        process.exitCode = 1;
        return;
      }
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
            dedupeKey:
              typeof options.dedupeKey === "string"
                ? options.dedupeKey
                : undefined,
            evidenceText:
              typeof options.input === "string" ? options.input : undefined,
          },
          { repoRoot: path.resolve(process.cwd()) },
        );
        console.log(
          JSON.stringify(
            {
              jobId: result.jobId,
              kind: result.kind,
              workflowId: result.workflowId,
              runMode: result.runMode,
              ...(result.applyMode ? { applyMode: result.applyMode } : {}),
              pack: result.pack,
              ...(result.workflow ? { workflow: result.workflow } : {}),
              engine: result.engine,
              ...(result.requestId ? { requestId: result.requestId } : {}),
              temporalUi: "http://localhost:8080",
            },
            null,
            2,
          ),
        );

        if (options.wait === false || result.engine === "local") {
          return;
        }
        await waitForJob(result.kind, result.jobId, result.workflowId);
      } catch (error) {
        printJobError(error);
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
    .action(
      async (options: { kind?: string; status?: string; limit?: string }) => {
        const store = await initStore();
        try {
          const kind = options.kind ? parseKind(options.kind) : undefined;
          const jobs = await listJobs(store, {
            ...(kind ? { kind } : {}),
            ...(options.status ? { status: options.status } : {}),
            limit: Number(options.limit ?? 20),
          });
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
        } catch (error) {
          printJobError(error);
        } finally {
          await store.close();
        }
      },
    );

  job
    .command("show <jobId>")
    .description("Show a job summary")
    .option("--kind <kind>", "pack-run | iteration")
    .action(async (jobId: string, options: { kind?: string }) => {
      const store = await initStore();
      try {
        const kinds: JobKind[] = options.kind
          ? [parseKind(options.kind) ?? "iteration"]
          : ["iteration", "packRun"];
        for (const kind of kinds) {
          const found = await getJob(store, kind, jobId);
          if (found) {
            console.log(JSON.stringify(found, null, 2));
            return;
          }
        }
        console.error("✖ job not found");
        process.exitCode = 1;
      } catch (error) {
        printJobError(error);
      } finally {
        await store.close();
      }
    });

  job
    .command("abort <jobId>")
    .description("Abort a running job")
    .requiredOption("--kind <kind>", "pack-run | iteration")
    .action(async (jobId: string, options: { kind: string }) => {
      const kind = parseKind(options.kind);
      if (!kind) {
        console.error("✖ --kind must be pack-run or iteration");
        process.exitCode = 1;
        return;
      }
      const store = await initStore();
      try {
        const result = await abortJob(store, kind, jobId, {
          repoRoot: path.resolve(process.cwd()),
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        printJobError(error);
      } finally {
        await store.close();
      }
    });

  job
    .command("changes [jobId]")
    .description("List pending changes that require manual apply")
    .action(async (jobId?: string) => {
      const store = await initStore();
      try {
        const changes = await listPendingChanges(store, jobId);
        if (changes.length === 0) {
          console.log("No pending changes.");
          return;
        }
        console.log(JSON.stringify(changes, null, 2));
      } catch (error) {
        printJobError(error);
      } finally {
        await store.close();
      }
    });

  job
    .command("apply <ticketId>")
    .description("Apply a pending change (requires a note)")
    .requiredOption("--note <text>", "reason for applying")
    .action(async (ticketId: string, options: { note: string }) => {
      const store = await initStore();
      try {
        const result = await applyPendingChange(store, ticketId, {
          actor: "operator:cli",
          note: options.note,
          repoRoot: path.resolve(process.cwd()),
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        printJobError(error);
      } finally {
        await store.close();
      }
    });
}

export async function startIterationFromCli(
  options: StartIterationOptions,
): Promise<void> {
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
        maxRepair: options.maxRepair ? Number(options.maxRepair) : 2,
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
        dedupeKey: options.dedupeKey,
      },
      { repoRoot: path.resolve(process.cwd()) },
    );
    console.log(
      JSON.stringify(
        {
          iterationId: result.jobId,
          workflowId: result.workflowId,
          runMode: result.runMode,
          applyMode: result.applyMode,
          pack: result.pack,
          temporalUi: "http://localhost:8080",
        },
        null,
        2,
      ),
    );
    if (options.wait === false) {
      return;
    }
    await waitForJob("iteration", result.jobId, result.workflowId);
  } catch (error) {
    printJobError(error);
  } finally {
    await store.close();
  }
}

async function waitForJob(
  kind: JobKind,
  jobId: string,
  workflowId: string,
): Promise<void> {
  const { client, connection } = await createTemporalClient();
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const handle = client.workflow.getHandle(workflowId);
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
    const result = await handle.result();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      `✖ job failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    if (timer) {
      clearInterval(timer);
    }
    await connection.close();
  }
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

function printJobError(error: unknown): void {
  if (error instanceof JobError) {
    console.error(`✖ ${error.code}: ${error.message}`);
  } else {
    console.error(
      `✖ ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exitCode = 1;
}
