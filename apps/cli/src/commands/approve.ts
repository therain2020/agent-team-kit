import { CliError } from "@kit/core";
import {
  decideApprovalRecord,
  findApprovalRequest,
  recordDecision,
} from "@kit/manager";
import { initStore } from "@kit/store";
import { createTemporalClient } from "@kit/workflow";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

interface ApproveOptions {
  decision: string;
  note: string;
  idempotencyKey?: string;
  json: boolean;
}

export function registerApprove(program: Command): void {
  program
    .command("approve <runId>")
    .description("Approve or abort a paused run")
    .requiredOption("--decision <decision>", "approve | abort")
    .option("--note <text>", "decision note", "")
    .option(
      "--idempotency-key <key>",
      "caller-supplied key; approvals are already idempotent per request id",
    )
    .option("--json", "machine-readable output", false)
    .action(async (runId: string, options: ApproveOptions) => {
      const json = wantsJson(options);
      if (options.decision !== "approve" && options.decision !== "abort") {
        emitError(
          json,
          new CliError("usage", "--decision must be approve or abort"),
        );
        return;
      }

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
              details: {
                detail: error instanceof Error ? error.message : String(error),
              },
            },
          ),
        );
        return;
      }
      let requestId: string | undefined;
      let alreadyRecorded = false;

      try {
        const run = await store.runs.get(runId);
        if (!run) {
          throw new CliError("not_found", `run not found: ${runId}`);
        }
        if (run.status !== "paused") {
          throw new CliError("conflict", `run is ${run.status}, not paused`);
        }

        const approval = await findApprovalRequest(store, runId);
        if (!approval) {
          throw new CliError("not_found", "approval request not found");
        }
        if (
          approval.expiresAt &&
          new Date(approval.expiresAt).getTime() < Date.now()
        ) {
          throw new CliError("conflict", "approval request expired");
        }
        requestId = approval.requestId;

        // The approval ledger is keyed by request id: a repeat submission with
        // the same run/request is a no-op, which is the idempotency guarantee
        // for this command. A caller-supplied key is echoed for traceability.
        const recorded = await decideApprovalRecord(store, {
          runId,
          requestId,
          decision: options.decision,
          actor: "operator",
          note: options.note,
        });
        if (!recorded.ok) {
          throw new CliError("conflict", recorded.error);
        }
        if (recorded.duplicate) {
          alreadyRecorded = true;
          if (!json) {
            console.error(
              `! decision already recorded for ${requestId}; re-signaling`,
            );
          }
        } else {
          await recordDecision(store, runId, options.decision, options.note, {
            requestId,
            actor: "operator",
            ...(recorded.batchId ? { batchId: recorded.batchId } : {}),
          });
        }
      } catch (error) {
        emitError(json, error, (classified) => {
          console.error(`✖ approval rejected: ${classified.message}`);
        });
        await store.close();
        return;
      }
      await store.close();

      const { client, connection } = await createTemporalClient();

      try {
        const handle = client.workflow.getHandle(`pack-${runId}`);
        await handle.signal("approval", {
          decision: options.decision,
          note: options.note,
          requestId,
        });
        emit(
          json,
          {
            runId,
            decision: options.decision,
            requestId,
            signaled: true,
            alreadyRecorded,
            ...(options.idempotencyKey
              ? { idempotencyKey: options.idempotencyKey }
              : {}),
          },
          () => {
            console.log(
              JSON.stringify(
                {
                  runId,
                  decision: options.decision,
                  requestId,
                  signaled: true,
                },
                null,
                2,
              ),
            );
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (json) {
          emitError(
            json,
            new CliError(
              "dependency_unavailable",
              `decision recorded, but signal failed: ${message}`,
              { details: { runId, decision: options.decision, requestId } },
            ),
          );
        } else {
          console.error(`! decision recorded, but signal failed: ${message}`);
          process.exitCode = 1;
        }
      } finally {
        await connection.close();
      }
    });
}
