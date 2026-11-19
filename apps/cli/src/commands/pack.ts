import path from "node:path";
import { CliError, eventEnvelopeSchema, newId } from "@kit/core";
import { runPackWorkflowLocal } from "@kit/engine";
import { buildPackRun, loadPack, simulatePack } from "@kit/pack";
import { initStore } from "@kit/store";
import { createTemporalClient, taskQueue } from "@kit/workflow";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";
import { exportPack } from "../pack-export";

export function registerPack(program: Command): void {
  const pack = program.command("pack").description("Team Pack operations");

  pack
    .command("validate <dir>")
    .description("Validate a Team Pack")
    .option("--json", "machine-readable output", false)
    .action(async (dir: string, options: { json?: boolean }) => {
      const json = wantsJson(options);
      const result = await loadPack(dir);

      if (!result.ok) {
        emitError(
          json,
          packLoadError("validate failed", path.resolve(dir), result.errors),
        );
        return;
      }

      const { pack: parsed } = result;
      emit(
        json,
        {
          dir: path.resolve(dir),
          name: parsed.metadata.name,
          version: parsed.metadata.version,
          apiVersion: parsed.apiVersion,
          agents: parsed.agents.length,
          skills: result.skills.size,
          workflows: result.workflows.length,
          policies: result.policies.length,
          warnings: result.warnings,
        },
        () => {
          console.log(
            `✔ ${parsed.metadata.name}@${parsed.metadata.version} (${parsed.apiVersion})`,
          );
          console.log(
            `  agents: ${parsed.agents.length}  skills: ${result.skills.size}  workflows: ${result.workflows.length}  policies: ${result.policies.length}`,
          );
          for (const warning of result.warnings) {
            console.log(`  ! ${warning}`);
          }
        },
      );
    });

  pack
    .command("simulate <dir>")
    .description("Simulate a Team Pack without side effects")
    .option("--json", "machine-readable output", false)
    .action(async (dir: string, options: { json?: boolean }) => {
      const json = wantsJson(options);
      const result = await loadPack(dir);

      if (!result.ok) {
        emitError(
          json,
          packLoadError("simulate failed", path.resolve(dir), result.errors),
        );
        return;
      }

      const report = simulatePack(result);
      emit(json, report, () => {
        console.log(JSON.stringify(report, null, 2));
      });
    });

  pack
    .command("run <dir>")
    .description("Run a pack workflow through Temporal (dry-run)")
    .option("--workflow <id>", "workflow id (default: first)")
    .option("--input <text>", "initial input")
    .option("--input-file <path>", "initial input file (e.g. evidence JSON)")
    .option("--stub", "force stub model", false)
    .option("--dry-run", "no external side effects", false)
    .option(
      "--idempotency-key <key>",
      "caller-supplied key; used as the event idempotency key",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (
        dir: string,
        options: {
          workflow?: string;
          input?: string;
          inputFile?: string;
          stub: boolean;
          dryRun: boolean;
          idempotencyKey?: string;
          json?: boolean;
        },
      ) => {
        const json = wantsJson(options);
        if (!options.dryRun) {
          emitError(json, new CliError("usage", "M1 only supports --dry-run"));
          return;
        }

        const loaded = await loadPack(dir);
        if (!loaded.ok) {
          emitError(
            json,
            packLoadError("cannot run: invalid Team Pack", dir, loaded.errors),
          );
          return;
        }

        let built: Awaited<ReturnType<typeof buildPackRun>>;
        try {
          built = await buildPackRun(loaded, options);
        } catch (error) {
          emitError(
            json,
            new CliError(
              "usage",
              `cannot build run: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
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
            idempotencyKey:
              options.idempotencyKey ?? `pack:${built.input.runId}`,
            traceId: newId("trc"),
            payloadRef: "memory://pack",
          });
          await store.events.insert(event);

          if (store.driver === "sqlite") {
            const result = await runPackWorkflowLocal(built.input, { store });
            const data = {
              pack: loaded.pack.metadata.name,
              workflow: built.workflow.id,
              runId: built.input.runId,
              engine: "local",
              ...(options.idempotencyKey
                ? { idempotencyKey: options.idempotencyKey }
                : {}),
              result,
            };
            emit(json, data, () => {
              console.log(JSON.stringify(data, null, 2));
            });
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

            const data = {
              pack: loaded.pack.metadata.name,
              workflow: built.workflow.id,
              runId: built.input.runId,
              engine: "temporal",
              workflowId: handle.workflowId,
              ...(options.idempotencyKey
                ? { idempotencyKey: options.idempotencyKey }
                : {}),
              result,
            };
            emit(json, data, () => {
              console.log(JSON.stringify(data, null, 2));
            });
          } finally {
            await connection.close();
          }
        } catch (error) {
          emitError(json, error);
        } finally {
          await store.close();
        }
      },
    );

  pack
    .command("export <dir>")
    .description("Export a Team Pack as a zip with a hashed manifest")
    .option("--out <file>", "output zip path")
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (
        dir: string,
        options: { out?: string; idempotencyKey?: string; json?: boolean },
      ) => {
        const json = wantsJson(options);
        const loaded = await loadPack(dir);
        if (!loaded.ok) {
          emitError(json, packLoadError("export failed", dir, loaded.errors));
          return;
        }

        const out =
          options.out ??
          `${loaded.pack.metadata.name}-${loaded.pack.metadata.version}.zip`;

        try {
          const result = await exportPack(loaded, out);
          const data = {
            outFile: result.outFile,
            files: result.files,
            name: result.manifest.name,
            version: result.manifest.version,
            ...(options.idempotencyKey
              ? { idempotencyKey: options.idempotencyKey }
              : {}),
          };
          emit(json, data, () => {
            console.log(JSON.stringify(data, null, 2));
          });
        } catch (error) {
          emitError(
            json,
            new CliError(
              "internal",
              `export failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      },
    );
}

function packLoadError(
  prefix: string,
  dir: string,
  errors: string[],
): CliError {
  const missing = errors.some((error) => error.includes("team.yaml not found"));
  return new CliError(missing ? "not_found" : "usage", `${prefix}: ${dir}`, {
    hint: missing
      ? "use the directory that contains team.yaml (try `kit init <dir>` first)"
      : undefined,
    details: { errors },
  });
}
