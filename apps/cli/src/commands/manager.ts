import { askManager, buildManagerBrief, recordDecision } from "@kit/manager";
import { initStore } from "@kit/store";
import type { Command } from "commander";

export function registerManager(program: Command): void {
  const manager = program
    .command("manager")
    .description("Manager brief and decision records");

  manager
    .command("brief <runId>")
    .description("Build a structured brief for a run")
    .action(async (runId: string) => {
      const store = await initStore();

      try {
        const { brief, artifactId } = await buildManagerBrief(store, runId);
        console.log(
          JSON.stringify({ ...brief, briefArtifactId: artifactId }, null, 2),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`✖ brief failed: ${message}`);
        process.exitCode = 1;
      } finally {
        await store.close();
      }
    });

  manager
    .command("ask <runId> <question>")
    .description("Ask the Manager about a run")
    .action(async (runId: string, question: string) => {
      const store = await initStore();

      try {
        const result = await askManager(store, runId, question);
        console.log(JSON.stringify({ runId, question, ...result }, null, 2));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`✖ ask failed: ${message}`);
        process.exitCode = 1;
      } finally {
        await store.close();
      }
    });

  manager
    .command("decide <runId>")
    .description("Record a manager decision")
    .requiredOption("--option <option>", "approve | revise | abort")
    .option("--note <text>", "decision note", "")
    .action(
      async (runId: string, options: { option: string; note: string }) => {
        const store = await initStore();

        try {
          const { decision, artifactId } = await recordDecision(
            store,
            runId,
            options.option,
            options.note,
          );
          console.log(JSON.stringify({ ...decision, artifactId }, null, 2));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(`✖ decision failed: ${message}`);
          process.exitCode = 1;
        } finally {
          await store.close();
        }
      },
    );
}
