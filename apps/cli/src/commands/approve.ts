import {
  decideApprovalRecord,
  findApprovalRequest,
  recordDecision,
} from "@kit/manager";
import { initStore } from "@kit/store";
import { createTemporalClient } from "@kit/workflow";
import type { Command } from "commander";

export function registerApprove(program: Command): void {
  program
    .command("approve <runId>")
    .description("Approve or abort a paused run")
    .requiredOption("--decision <decision>", "approve | abort")
    .option("--note <text>", "decision note", "")
    .action(
      async (runId: string, options: { decision: string; note: string }) => {
        if (options.decision !== "approve" && options.decision !== "abort") {
          console.error("✖ --decision must be approve or abort");
          process.exitCode = 1;
          return;
        }

        const store = await initStore();
        let requestId: string | undefined;

        try {
          const run = await store.runs.get(runId);
          if (!run) {
            throw new Error(`run not found: ${runId}`);
          }
          if (run.status !== "paused") {
            throw new Error(`run is ${run.status}, not paused`);
          }

          const approval = await findApprovalRequest(store, runId);
          if (!approval) {
            throw new Error("approval request not found");
          }
          if (
            approval.expiresAt &&
            new Date(approval.expiresAt).getTime() < Date.now()
          ) {
            throw new Error("approval request expired");
          }
          requestId = approval.requestId;

          const recorded = await decideApprovalRecord(store, {
            runId,
            requestId,
            decision: options.decision,
            actor: "operator",
            note: options.note,
          });
          if (!recorded.ok) {
            throw new Error(recorded.error);
          }
          if (recorded.duplicate) {
            console.error(
              `! decision already recorded for ${requestId}; re-signaling`,
            );
          } else {
            await recordDecision(store, runId, options.decision, options.note, {
              requestId,
              actor: "operator",
              ...(recorded.batchId ? { batchId: recorded.batchId } : {}),
            });
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(`✖ approval rejected: ${message}`);
          process.exitCode = 1;
          return;
        } finally {
          await store.close();
        }

        const { client, connection } = await createTemporalClient();

        try {
          const handle = client.workflow.getHandle(`pack-${runId}`);
          await handle.signal("approval", {
            decision: options.decision,
            note: options.note,
            requestId,
          });
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
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(`! decision recorded, but signal failed: ${message}`);
          process.exitCode = 1;
        } finally {
          await connection.close();
        }
      },
    );
}
