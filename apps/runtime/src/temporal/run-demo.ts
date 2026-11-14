import { eventEnvelopeSchema, newId } from "@kit/core";
import { initStore } from "@kit/store";
import { createTemporalClient, taskQueue } from "./client";
import type { DemoInput } from "./types";
import { demoWorkflow } from "./workflows";

const store = await initStore();
const { client, connection } = await createTemporalClient();
const runId = newId("run");
const now = new Date().toISOString();

const event = eventEnvelopeSchema.parse({
  eventId: newId("evt"),
  type: "demo.event.received",
  schemaVersion: "1.0",
  occurredAt: now,
  receivedAt: now,
  workspaceId: "default",
  idempotencyKey: `demo:${runId}`,
  traceId: newId("trc"),
  payloadRef: "memory://demo",
});
await store.events.insert(event);

const input: DemoInput = {
  runId,
  eventId: event.eventId,
  workspaceId: "default",
  sleepMs: 0,
};

const handle = await client.workflow.start(demoWorkflow, {
  taskQueue,
  workflowId: `demo-${runId}`,
  args: [input],
});

console.log(JSON.stringify(await handle.result(), null, 2));
await connection.close();
await store.sql.end();
