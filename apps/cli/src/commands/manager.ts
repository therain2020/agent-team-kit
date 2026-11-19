import { CliError } from "@kit/core";
import { askManager, buildManagerBrief, recordDecision } from "@kit/manager";
import { initStore } from "@kit/store";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

export function registerManager(program: Command): void {
  const manager = program
    .command("manager")
    .description("Manager brief and decision records");

  manager
    .command("brief <runId>")
    .description("Build a structured brief for a run")
    .option("--json", "machine-readable output", false)
    .action(async (runId: string, options: { json?: boolean }) => {
      const json = wantsJson(options);
      const store = await initStore();

      try {
        const { brief, artifactId } = await buildManagerBrief(store, runId);
        const data = { ...brief, briefArtifactId: artifactId };
        emit(json, data, () => {
          console.log(JSON.stringify(data, null, 2));
        });
      } catch (error) {
        emitError(
          json,
          new CliError(
            "internal",
            `brief failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      } finally {
        await store.close();
      }
    });

  manager
    .command("ask <runId> <question>")
    .description("Ask the Manager about a run")
    .option("--json", "machine-readable output", false)
    .action(
      async (runId: string, question: string, options: { json?: boolean }) => {
        const json = wantsJson(options);
        const store = await initStore();

        try {
          const result = await askManager(store, runId, question);
          const data = { runId, question, ...result };
          emit(json, data, () => {
            console.log(JSON.stringify(data, null, 2));
          });
        } catch (error) {
          emitError(
            json,
            new CliError(
              "internal",
              `ask failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        } finally {
          await store.close();
        }
      },
    );

  manager
    .command("decide <runId>")
    .description("Record a manager decision")
    .requiredOption("--option <option>", "approve | revise | abort")
    .option("--note <text>", "decision note", "")
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (
        runId: string,
        options: {
          option: string;
          note: string;
          idempotencyKey?: string;
          json?: boolean;
        },
      ) => {
        const json = wantsJson(options);
        const store = await initStore();

        try {
          const { decision, artifactId } = await recordDecision(
            store,
            runId,
            options.option,
            options.note,
          );
          const data = {
            ...decision,
            artifactId,
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
              `decision failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        } finally {
          await store.close();
        }
      },
    );
}
