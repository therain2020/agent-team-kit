import { CliError } from "@kit/core";
import { initStore } from "@kit/store";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

export function registerStatus(program: Command): void {
  program
    .command("status [runId]")
    .description("Show runs, stages and artifacts")
    .option("--json", "machine-readable output", false)
    .action(async (runId: string | undefined, options: { json: boolean }) => {
      const json = wantsJson(options);
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
        if (!runId) {
          const runs = await store.runs.listRecent(10);
          emit(json, { runs }, () => {
            if (runs.length === 0) {
              console.log("no runs");
              return;
            }
            for (const run of runs) {
              console.log(
                `${run.runId}  ${run.status}  ${run.workspaceId}  ${run.createdAt}`,
              );
            }
          });
          return;
        }

        const run = await store.runs.get(runId);
        if (!run) {
          emitError(json, new CliError("not_found", `run not found: ${runId}`));
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

        const data = { run, stages, artifacts: details };
        emit(json, data, () => {
          console.log(JSON.stringify(data, null, 2));
        });
      } catch (error) {
        emitError(json, error);
      } finally {
        await store.close();
      }
    });
}
