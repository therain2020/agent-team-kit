import { readFile } from "node:fs/promises";
import path from "node:path";
import { eventEnvelopeSchema, newId } from "@kit/core";
import { loadPack } from "@kit/pack";
import { initStore } from "@kit/store";
import { initTelemetry, shutdownTelemetry } from "@kit/telemetry";
import { createTemporalClient, taskQueue } from "@kit/workflow";
import { trace } from "@opentelemetry/api";
import type { Command } from "commander";
import { parse } from "yaml";

interface RunOptions {
  pack: string;
  dryRun: boolean;
}

export function registerRun(program: Command): void {
  program
    .command("run")
    .description("Run a Team Pack through the Temporal loop (M0)")
    .requiredOption("--pack <dir>", "Team Pack directory")
    .option("--dry-run", "run without external side effects", false)
    .action(async (options: RunOptions) => {
      if (!options.dryRun) {
        console.error("✖ M0 only supports --dry-run");
        process.exitCode = 1;
        return;
      }

      const packResult = await loadPack(options.pack);
      if (!packResult.ok) {
        console.error("✖ cannot run: invalid Team Pack");
        for (const error of packResult.errors) {
          console.error(`  - ${error}`);
        }
        process.exitCode = 1;
        return;
      }

      const workflowFile = packResult.pack.workflows[0];
      if (!workflowFile) {
        console.error("✖ pack has no workflow");
        process.exitCode = 1;
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
          idempotencyKey: `cli:${runId}`,
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

        console.log(
          JSON.stringify(
            {
              mode: "DRY_RUN",
              pack: packResult.pack.metadata.name,
              runId,
              workflowId: handle.workflowId,
              eventId: event.eventId,
              result,
            },
            null,
            2,
          ),
        );
      } finally {
        span.end();
        await connection.close();
        await store.sql.end();
        await shutdownTelemetry();
      }
    });
}
