import path from "node:path";
import { newId } from "@kit/core";
import { loadPack } from "@kit/pack";
import {
  type IterationInput,
  createTemporalClient,
  taskQueue,
} from "@kit/workflow";
import type { Command } from "commander";

export function registerIterate(program: Command): void {
  program
    .command("iterate")
    .description("Plan and run a task-centric self-iteration")
    .requiredOption("--goal <text>", "iteration goal")
    .option("--acceptance <text>", "overall acceptance criteria")
    .option("--domain <name>", "restrict the plan to one domain")
    .option("--pack <dir>", "iteration pack directory", "packs/self-improve")
    .option("--max-tasks <n>", "maximum tasks to plan", "4")
    .option("--max-repair <n>", "repair attempts per task", "2")
    .option("--coder <id>", "override coder for all domains")
    .option("--apply <mode>", "auto-apply mode: none | low | low-medium", "low")
    .option("--live", "run in LIVE mode (otherwise DRY_RUN)", false)
    .option("--stub", "use the deterministic planner", false)
    .option("--budget-cny <n>", "optional iteration budget")
    .action(
      async (options: {
        goal: string;
        acceptance?: string;
        domain?: string;
        pack: string;
        maxTasks: string;
        maxRepair: string;
        coder?: string;
        apply: string;
        live: boolean;
        stub: boolean;
        budgetCny?: string;
      }) => {
        const packDir = path.resolve(options.pack);
        const loaded = await loadPack(packDir);
        if (!loaded.ok) {
          console.error("✖ invalid iteration pack");
          for (const error of loaded.errors) {
            console.error(`  - ${error}`);
          }
          process.exitCode = 1;
          return;
        }
        if (!loaded.iteration) {
          console.error("✖ pack has no iteration.yaml");
          process.exitCode = 1;
          return;
        }

        const applyMode = options.live ? parseApplyMode(options.apply) : "none";
        if (!applyMode) {
          console.error("✖ apply must be none, low, or low-medium");
          process.exitCode = 1;
          return;
        }
        const coder = parseCoder(options.coder);
        if (options.coder && !coder) {
          console.error("✖ coder must be dsh, codex, opencode, or command");
          process.exitCode = 1;
          return;
        }

        const input: IterationInput = {
          iterationId: newId("it"),
          workspaceId: "default",
          packDir,
          goal: options.goal,
          ...(options.acceptance ? { acceptance: options.acceptance } : {}),
          ...(options.domain ? { domain: options.domain } : {}),
          maxTasks: clampInt(options.maxTasks, 1, 20, 4),
          maxRepair: clampInt(options.maxRepair, 0, 5, 2),
          runMode: options.live ? "LIVE" : "DRY_RUN",
          applyMode,
          ...(coder ? { coder } : {}),
          stub: options.stub,
          ...(options.budgetCny
            ? { budgetCny: Number(options.budgetCny) }
            : {}),
        };

        const { client, connection } = await createTemporalClient();
        let timer: ReturnType<typeof setInterval> | undefined;
        try {
          const handle = await client.workflow.start("iterationWorkflow", {
            taskQueue,
            workflowId: `iteration-${input.iterationId}`,
            args: [input],
          });
          timer = setInterval(() => {
            void (async () => {
              try {
                const description = await handle.describe();
                console.log(`[iterate] status=${description.status.name}`);
              } catch {
                // workflow may be closing
              }
            })();
          }, 15_000);

          console.log(
            JSON.stringify(
              {
                iterationId: input.iterationId,
                workflowId: handle.workflowId,
                runMode: input.runMode,
                applyMode: input.applyMode,
                pack: packDir,
                temporalUi: "http://localhost:8080",
              },
              null,
              2,
            ),
          );

          const result = await handle.result();
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(`✖ iteration failed: ${message}`);
          process.exitCode = 1;
        } finally {
          if (timer) {
            clearInterval(timer);
          }
          await connection.close();
        }
      },
    );
}

function parseApplyMode(value: string): "none" | "low" | "low-medium" | null {
  return value === "none" || value === "low" || value === "low-medium"
    ? value
    : null;
}

function parseCoder(
  value: string | undefined,
): "dsh" | "codex" | "opencode" | "command" | undefined {
  if (!value) {
    return undefined;
  }
  return value === "dsh" ||
    value === "codex" ||
    value === "opencode" ||
    value === "command"
    ? value
    : undefined;
}

function clampInt(
  value: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
