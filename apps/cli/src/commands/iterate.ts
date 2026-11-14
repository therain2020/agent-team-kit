import type { Command } from "commander";
import { startIterationFromCli } from "./job";

export function registerIterate(program: Command): void {
  program
    .command("iterate")
    .description(
      "Plan and run a task-centric self-iteration (alias of job start)",
    )
    .requiredOption("--goal <text>", "iteration goal")
    .option("--acceptance <text>", "overall acceptance criteria")
    .option("--domain <name>", "restrict the plan to one domain")
    .option("--pack <dir>", "iteration pack directory", "packs/self-improve")
    .option("--max-tasks <n>", "maximum tasks to plan", "4")
    .option(
      "--max-repair <n>",
      "repair attempts per task (default: KIT_REPAIR_ROUNDS or 2)",
    )
    .option("--coder <id>", "override coder for all domains")
    .option("--apply <mode>", "auto-apply mode: none | low | low-medium", "low")
    .option("--live", "run in LIVE mode (otherwise DRY_RUN)", false)
    .option("--stub", "use the deterministic planner", false)
    .option("--budget-cny <n>", "optional iteration budget")
    .option(
      "--dedupe-key <key>",
      "stable key: attach to an existing run instead of starting a duplicate",
    )
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
        dedupeKey?: string;
      }) => {
        await startIterationFromCli({
          ...options,
          wait: true,
        });
      },
    );
}
