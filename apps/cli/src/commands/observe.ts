import {
  buildObserverTimeline,
  listObserverActions,
  summarizeObserverMetrics,
} from "@kit/activity";
import { initStore } from "@kit/store";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

/**
 * Read-only observer commands (98 §3.5, issue #134): the CLI mirrors the
 * console's observation-first view without adding a second intervention surface
 * — pause/kill/rollback/edit keep their existing commands.
 */
export function registerObserve(program: Command): void {
  const observe = program
    .command("observe")
    .description("Read-only observer timeline, metrics and intervention audit");

  observe
    .command("timeline")
    .description("Show information → reaction → job from the local store")
    .option("--limit <n>", "number of information events", "20")
    .option("--json", "machine-readable output", false)
    .action(async (options: { limit: string; json?: boolean }) => {
      const json = wantsJson(options);
      await withStore(json, async (store) => {
        const limit = Math.max(1, Number(options.limit) || 20);
        const timeline = await buildObserverTimeline(store, { limit });
        emit(json, { timeline }, () => {
          if (timeline.length === 0) {
            console.log("No information events yet. Run: kit source collect");
            return;
          }
          for (const entry of timeline) {
            const at = entry.event.receivedAt.slice(0, 19).replace("T", " ");
            console.log(`${at}  ${entry.event.sourceId}  ${entry.event.title}`);
            if (entry.reaction) {
              console.log(
                `  → ${entry.reaction.ruleId}  ${entry.reaction.status}  job=${
                  entry.reaction.jobId ?? "-"
                }`,
              );
            } else {
              console.log("  → awaiting reaction");
            }
          }
        });
      });
    });

  observe
    .command("metrics")
    .description(
      "Intervention rate, reaction accuracy and gate approval median",
    )
    .option("--json", "machine-readable output", false)
    .action(async (options: { json?: boolean }) => {
      const json = wantsJson(options);
      await withStore(json, async (store) => {
        const metrics = await summarizeObserverMetrics(store);
        emit(json, metrics, () => {
          const rate =
            metrics.interventionRate === null
              ? "—"
              : `${metrics.interventionRate.toFixed(2)}/reaction`;
          const accuracy =
            metrics.reactionAccuracy === null
              ? "—"
              : `${(metrics.reactionAccuracy * 100).toFixed(0)}%`;
          const median =
            metrics.medianGateDecisionMinutes === null
              ? "—"
              : `${metrics.medianGateDecisionMinutes.toFixed(0)} min`;
          console.log(`intervention rate  ${rate}`);
          console.log(`reaction accuracy  ${accuracy}`);
          console.log(`gate median        ${median}`);
          console.log(
            `actions            ${metrics.actions24h} (24h) / ${metrics.actions7d} (7d)`,
          );
          console.log(
            `reactions          ${metrics.reactions7d} (7d, ${metrics.failedReactions7d} failed)`,
          );
        });
      });
    });

  observe
    .command("actions")
    .description("List the audited intervention ledger (newest first)")
    .option("--limit <n>", "number of actions", "20")
    .option("--json", "machine-readable output", false)
    .action(async (options: { limit: string; json?: boolean }) => {
      const json = wantsJson(options);
      await withStore(json, async (store) => {
        const limit = Math.max(1, Number(options.limit) || 20);
        const actions = await listObserverActions(store, { limit });
        emit(json, { actions }, () => {
          if (actions.length === 0) {
            console.log("No interventions recorded.");
            return;
          }
          for (const action of actions) {
            const reference = action.reference ? `  ${action.reference}` : "";
            console.log(
              `${action.createdAt.slice(0, 19).replace("T", " ")}  ${
                action.type
              }  ${action.actor}  ${action.targetRef}${reference}  ${
                action.reason
              }`,
            );
          }
        });
      });
    });
}

async function withStore(
  json: boolean,
  run: (store: Awaited<ReturnType<typeof initStore>>) => Promise<void>,
): Promise<void> {
  let store: Awaited<ReturnType<typeof initStore>>;
  try {
    store = await initStore();
  } catch (error) {
    emitError(json, error);
    return;
  }
  try {
    await run(store);
  } catch (error) {
    emitError(json, error);
  } finally {
    await store.close().catch(() => undefined);
  }
}
