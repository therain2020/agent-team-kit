import { initStore } from "@kit/store";
import type { Command } from "commander";

export function registerStatus(program: Command): void {
  program
    .command("status [runId]")
    .description("Show runs, stages and artifacts")
    .action(async (runId?: string) => {
      let store: Awaited<ReturnType<typeof initStore>>;
      try {
        store = await initStore();
      } catch (error) {
        console.error("✖ cannot reach the kit database");
        console.error(
          `  ${error instanceof Error ? error.message : String(error)}`,
        );
        console.error(
          "  start the stack with `kit up`, or point KIT_DB_URL at a running Postgres",
        );
        process.exitCode = 1;
        return;
      }

      try {
        if (!runId) {
          const runs = await store.runs.listRecent(10);
          if (runs.length === 0) {
            console.log("no runs");
            return;
          }
          for (const run of runs) {
            console.log(
              `${run.runId}  ${run.status}  ${run.workspaceId}  ${run.createdAt}`,
            );
          }
          return;
        }

        const run = await store.runs.get(runId);
        if (!run) {
          console.error(`✖ run not found: ${runId}`);
          process.exitCode = 1;
          return;
        }

        const stages = await store.stages.listByRun(runId);
        const artifacts = await store.artifactStore.listByRun(runId);
        const details = await Promise.all(
          artifacts.map(async (artifact) => ({
            artifact,
            manifest: await store.manifests.get(artifact.manifestId),
          })),
        );

        console.log(
          JSON.stringify({ run, stages, artifacts: details }, null, 2),
        );
      } finally {
        await store.sql.end();
      }
    });
}
