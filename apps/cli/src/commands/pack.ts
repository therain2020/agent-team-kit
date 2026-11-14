import path from "node:path";
import { eventEnvelopeSchema, newId } from "@kit/core";
import { runPackWorkflowLocal } from "@kit/engine";
import { buildPackRun, loadPack, simulatePack } from "@kit/pack";
import { initStore } from "@kit/store";
import { createTemporalClient, taskQueue } from "@kit/workflow";
import type { Command } from "commander";
import { exportPack } from "../pack-export";

export function registerPack(program: Command): void {
  const pack = program.command("pack").description("Team Pack operations");

  pack
    .command("validate <dir>")
    .description("Validate a Team Pack")
    .action(async (dir: string) => {
      const result = await loadPack(dir);

      if (!result.ok) {
        console.error(`✖ validate failed: ${path.resolve(dir)}`);
        for (const error of result.errors) {
          console.error(`  - ${error}`);
        }
        if (
          result.errors.some((error) => error.includes("team.yaml not found"))
        ) {
          console.error(
            "  use the directory that contains team.yaml (try `kit init <dir>` first)",
          );
        }
        process.exitCode = 1;
        return;
      }

      const { pack: parsed } = result;
      console.log(
        `✔ ${parsed.metadata.name}@${parsed.metadata.version} (${parsed.apiVersion})`,
      );
      console.log(
        `  agents: ${parsed.agents.length}  skills: ${result.skills.size}  workflows: ${result.workflows.length}  policies: ${result.policies.length}`,
      );
      for (const warning of result.warnings) {
        console.log(`  ! ${warning}`);
      }
    });

  pack
    .command("simulate <dir>")
    .description("Simulate a Team Pack without side effects")
    .action(async (dir: string) => {
      const result = await loadPack(dir);

      if (!result.ok) {
        console.error(`✖ simulate failed: ${path.resolve(dir)}`);
        for (const error of result.errors) {
          console.error(`  - ${error}`);
        }
        if (
          result.errors.some((error) => error.includes("team.yaml not found"))
        ) {
          console.error(
            "  use the directory that contains team.yaml (try `kit init <dir>` first)",
          );
        }
        process.exitCode = 1;
        return;
      }

      console.log(JSON.stringify(simulatePack(result), null, 2));
    });

  pack
    .command("run <dir>")
    .description("Run a pack workflow through Temporal (dry-run)")
    .option("--workflow <id>", "workflow id (default: first)")
    .option("--input <text>", "initial input")
    .option("--input-file <path>", "initial input file (e.g. evidence JSON)")
    .option("--stub", "force stub model", false)
    .option("--dry-run", "no external side effects", false)
    .action(
      async (
        dir: string,
        options: {
          workflow?: string;
          input?: string;
          inputFile?: string;
          stub: boolean;
          dryRun: boolean;
        },
      ) => {
        if (!options.dryRun) {
          console.error("✖ M1 only supports --dry-run");
          process.exitCode = 1;
          return;
        }

        const loaded = await loadPack(dir);
        if (!loaded.ok) {
          console.error("✖ cannot run: invalid Team Pack");
          for (const error of loaded.errors) {
            console.error(`  - ${error}`);
          }
          process.exitCode = 1;
          return;
        }

        let built: Awaited<ReturnType<typeof buildPackRun>>;
        try {
          built = await buildPackRun(loaded, options);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(`✖ cannot build run: ${message}`);
          process.exitCode = 1;
          return;
        }

        const store = await initStore();

        try {
          const now = new Date().toISOString();
          const event = eventEnvelopeSchema.parse({
            eventId: built.input.eventId,
            type: built.eventType,
            schemaVersion: "1.0",
            occurredAt: now,
            receivedAt: now,
            workspaceId: "default",
            idempotencyKey: `pack:${built.input.runId}`,
            traceId: newId("trc"),
            payloadRef: "memory://pack",
          });
          await store.events.insert(event);

          if (store.driver === "sqlite") {
            const result = await runPackWorkflowLocal(built.input, { store });
            console.log(
              JSON.stringify(
                {
                  pack: loaded.pack.metadata.name,
                  workflow: built.workflow.id,
                  runId: built.input.runId,
                  engine: "local",
                  result,
                },
                null,
                2,
              ),
            );
            return;
          }

          const { client, connection } = await createTemporalClient();
          try {
            const handle = await client.workflow.start("packWorkflow", {
              taskQueue,
              workflowId: `pack-${built.input.runId}`,
              args: [built.input],
            });
            const result = await handle.result();

            console.log(
              JSON.stringify(
                {
                  pack: loaded.pack.metadata.name,
                  workflow: built.workflow.id,
                  runId: built.input.runId,
                  engine: "temporal",
                  workflowId: handle.workflowId,
                  result,
                },
                null,
                2,
              ),
            );
          } finally {
            await connection.close();
          }
        } finally {
          await store.close();
        }
      },
    );

  pack
    .command("export <dir>")
    .description("Export a Team Pack as a zip with a hashed manifest")
    .option("--out <file>", "output zip path")
    .action(async (dir: string, options: { out?: string }) => {
      const loaded = await loadPack(dir);
      if (!loaded.ok) {
        console.error("✖ export failed");
        for (const error of loaded.errors) {
          console.error(`  - ${error}`);
        }
        process.exitCode = 1;
        return;
      }

      const out =
        options.out ??
        `${loaded.pack.metadata.name}-${loaded.pack.metadata.version}.zip`;

      try {
        const result = await exportPack(loaded, out);
        console.log(
          JSON.stringify(
            {
              outFile: result.outFile,
              files: result.files,
              name: result.manifest.name,
              version: result.manifest.version,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`✖ export failed: ${message}`);
        process.exitCode = 1;
      }
    });
}
