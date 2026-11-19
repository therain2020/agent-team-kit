import { readFile } from "node:fs/promises";
import path from "node:path";
import { CliError, eventEnvelopeSchema, newId } from "@kit/core";
import { loadPack } from "@kit/pack";
import { initStore } from "@kit/store";
import { initTelemetry, shutdownTelemetry } from "@kit/telemetry";
import { createTemporalClient, taskQueue } from "@kit/workflow";
import { trace } from "@opentelemetry/api";
import type { Command } from "commander";
import { parse } from "yaml";
import { emit, emitError, wantsJson } from "../output";

interface RunOptions {
  pack: string;
  dryRun: boolean;
  idempotencyKey?: string;
  json?: boolean;
}

export function registerRun(program: Command): void {
  program
    .command("run")
    .description("Run a Team Pack through the Temporal loop (M0)")
    .requiredOption("--pack <dir>", "Team Pack directory")
    .option("--dry-run", "run without external side effects", false)
    .option(
      "--idempotency-key <key>",
      "caller-supplied key; used as the event idempotency key",
    )
    .option("--json", "machine-readable output", false)
    .action(async (options: RunOptions) => {
      const json = wantsJson(options);
      console.warn(
        "[deprecated] `kit run` uses the M0 demo workflow; use `kit pack run <dir> --dry-run` or `kit job start --kind pack-run --pack <dir>`.",
      );
      if (!options.dryRun) {
        emitError(json, new CliError("usage", "M0 only supports --dry-run"));
        return;
      }

      const packResult = await loadPack(options.pack);
      if (!packResult.ok) {
        emitError(
          json,
          new CliError("usage", "cannot run: invalid Team Pack", {
            details: { errors: packResult.errors },
          }),
        );
        return;
      }

      const workflowFile = packResult.pack.workflows[0];
      if (!workflowFile) {
        emitError(json, new CliError("not_found", "pack has no workflow"));
        return;
      }

      const workflowDoc = parse(
        await readFile(path.join(packResult.dir, workflowFile), "utf8"),
      ) as { trigger?: { event?: string } };
      const eventType = workflowDoc.trigger?.event ?? "demo.event.received";

      initTelemetry({ serviceName: "kit-cli" });

      const store = await initStore();
      const { client, connection } = await createTemporalClient();
      const span = trace.getTracer("kit-cli").startSpan("kit.run");
      span.setAttribute("pack.name", packResult.pack.metadata.name);

      try {
        const runId = newId("run");
        span.setAttribute("run.id", runId);
        const now = new Date().toISOString();
        const event = eventEnvelopeSchema.parse({
          eventId: newId("evt"),
          type: eventType,
          schemaVersion: "1.0",
          occurredAt: now,
          receivedAt: now,
          workspaceId: "default",
          idempotencyKey: options.idempotencyKey ?? `cli:${runId}`,
          traceId: newId("trc"),
          payloadRef: "memory://cli",
        });

        await store.events.insert(event);

        const handle = await client.workflow.start("demoWorkflow", {
          taskQueue,
          workflowId: `demo-${runId}`,
          args: [
            {
              runId,
              eventId: event.eventId,
              workspaceId: "default",
              sleepMs: 0,
            },
          ],
        });

        const result = await handle.result();
        span.setAttribute(
          "artifacts.count",
          (result as { artifacts?: string[] }).artifacts?.length ?? 0,
        );

        const data = {
          mode: "DRY_RUN",
          pack: packResult.pack.metadata.name,
          runId,
          workflowId: handle.workflowId,
          eventId: event.eventId,
          ...(options.idempotencyKey
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
          result,
        };
        emit(json, data, () => {
          console.log(JSON.stringify(data, null, 2));
        });
      } catch (error) {
        emitError(json, error);
      } finally {
        span.end();
        await connection.close();
        await store.close();
        await shutdownTelemetry();
      }
    });
}
