import path from "node:path";
import { CliError } from "@kit/core";
import { initStore } from "@kit/store";
import {
  type EventRoute,
  type Trigger,
  eventRouteSchema,
  fireTrigger,
  loadTriggerPlane,
  registryFromPlane,
  triggerSchema,
} from "@kit/trigger";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

interface TriggerFireOptions {
  trigger?: string;
  pack?: string;
  workflow?: string;
  dedupeKey?: string;
  live?: boolean;
  json?: boolean;
}

export function registerTrigger(program: Command): void {
  const trigger = program
    .command("trigger")
    .description("List configured triggers and fire one manually");

  trigger
    .command("list")
    .description("List mapped triggers and their routes")
    .option("--json", "machine-readable output", false)
    .action(async (options: { json?: boolean }) => {
      const json = wantsJson(options);
      try {
        const plane = await loadTriggerPlane(path.resolve(process.cwd()));
        const data = {
          triggers: plane.triggers,
          routes: plane.routes,
          errors: plane.errors,
        };
        emit(json, data, () => {
          if (plane.errors.length > 0) {
            for (const error of plane.errors) {
              console.error(`✖ ${error}`);
            }
            return;
          }
          if (plane.triggers.length === 0) {
            console.log("No triggers configured.");
            return;
          }
          for (const item of plane.triggers) {
            const route = plane.routes.find(
              (candidate) => candidate.routeId === item.routeRef,
            );
            console.log(
              [
                item.kind.padEnd(9),
                item.enabled ? "enabled " : "disabled",
                item.triggerId,
                route?.jobKind ?? "?",
                route?.workflow ?? route?.goal ?? "",
              ]
                .join("  ")
                .trim(),
            );
          }
        });
      } catch (error) {
        emitError(json, error);
      }
    });

  trigger
    .command("fire")
    .description("Fire a configured trigger or an ad-hoc manual job")
    .option("--trigger <id>", "configured trigger id")
    .option("--pack <dir>", "pack directory for an ad-hoc manual firing")
    .option("--workflow <id>", "workflow id for an ad-hoc manual firing")
    .option("--dedupe-key <key>", "idempotency key for this firing")
    .option("--live", "run in LIVE mode (otherwise DRY_RUN)", false)
    .option("--json", "machine-readable output", false)
    .action(async (options: TriggerFireOptions) => {
      const json = wantsJson(options);
      const repoRoot = path.resolve(process.cwd());
      const actor = "operator:cli";
      if (!options.trigger && !(options.pack && options.workflow)) {
        emitError(
          json,
          new CliError("usage", "--trigger or --pack + --workflow is required"),
        );
        return;
      }

      const store = await initStore();
      try {
        const plane = await loadTriggerPlane(repoRoot);
        if (plane.errors.length > 0) {
          throw new CliError("usage", plane.errors.join("; "));
        }
        const registry = registryFromPlane(plane);
        const now = Date.now();

        let triggerId = options.trigger ?? `manual:${actor}`;
        let triggerDoc: Trigger | undefined;
        let routeDoc: EventRoute | undefined;
        if (options.trigger) {
          const configured = await registry.resolve(options.trigger);
          if (!configured) {
            throw new CliError("not_found", "trigger not found");
          }
          triggerId = configured.trigger.triggerId;
          triggerDoc = triggerSchema.parse({
            ...configured.trigger,
            kind: "manual",
            source: "manual",
            actor,
          });
          routeDoc = configured.route;
        } else {
          if (!options.pack || !options.workflow) {
            throw new CliError(
              "usage",
              "--pack and --workflow are required without --trigger",
            );
          }
          const pack = options.pack;
          const workflow = options.workflow;
          triggerId = `manual:${actor}`;
          triggerDoc = triggerSchema.parse({
            triggerId,
            kind: "manual",
            source: "manual",
            routeRef: `manual:${pack}`,
            actor,
          });
          routeDoc = eventRouteSchema.parse({
            routeId: `manual:${pack}`,
            triggerRef: triggerId,
            packDir: pack,
            jobKind: "packRun",
            workflow,
            runMode: options.live ? "LIVE" : "DRY_RUN",
          });
        }
        if (!triggerDoc || !routeDoc) {
          throw new CliError("not_found", "trigger route not found");
        }
        if (routeDoc.runMode === "LIVE" && options.live !== true) {
          throw new CliError(
            "usage",
            "this route runs LIVE; pass --live to confirm",
          );
        }

        const dedupeKey =
          options.dedupeKey ?? `manual:${actor}:${triggerId}:${now}`;
        const result = await fireTrigger(
          {
            triggerId,
            dedupeKey,
            trigger: triggerDoc,
            route: routeDoc,
            originKind: "manual",
            actor,
          },
          { store, repoRoot, registry },
        );
        emit(json, result, () => {
          console.log(
            [
              result.dispatch,
              result.jobId ?? "-",
              result.triggerRunId ?? "-",
              result.reason ?? "",
            ]
              .join("  ")
              .trim(),
          );
        });
        if (result.dispatch === "FAILED") {
          process.exitCode = 1;
        }
      } catch (error) {
        emitError(json, error);
      } finally {
        await store.close();
      }
    });
}
