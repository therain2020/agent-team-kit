import { fileURLToPath } from "node:url";
import { initTelemetry, shutdownTelemetry } from "@kit/telemetry";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import * as packActivities from "./pack-activities";

initTelemetry({ serviceName: "kit-worker" });

const address = process.env.KIT_TEMPORAL_ADDRESS ?? "localhost:7233";
const namespace = process.env.KIT_TEMPORAL_NAMESPACE ?? "default";
const taskQueue = process.env.KIT_TASK_QUEUE ?? "kit-demo";

const connection = await NativeConnection.connect({ address });

const worker = await Worker.create({
  connection,
  namespace,
  taskQueue,
  workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
  activities: { ...activities, ...packActivities },
});

console.log(
  `[worker] ready address=${address} namespace=${namespace} queue=${taskQueue}`,
);

process.once("SIGINT", () => worker.shutdown());
process.once("SIGTERM", () => worker.shutdown());

await worker.run();
await shutdownTelemetry();
