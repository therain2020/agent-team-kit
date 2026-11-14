import { fileURLToPath } from "node:url";
import { initTelemetry, shutdownTelemetry } from "@kit/telemetry";
import { applyTaskQueue } from "@kit/workflow";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import * as iterationActivities from "./iteration-activities";
import * as packActivities from "./pack-activities";

initTelemetry({ serviceName: "kit-worker" });

const address = process.env.KIT_TEMPORAL_ADDRESS ?? "localhost:7233";
const namespace = process.env.KIT_TEMPORAL_NAMESPACE ?? "default";
const taskQueue = process.env.KIT_TASK_QUEUE ?? "kit-demo";
const activityConcurrency = clampInt(
  process.env.KIT_WORKER_ACTIVITY_CONCURRENCY,
  1,
  100,
  8,
);

const connection = await NativeConnection.connect({ address });
const { applyIterationTask, ...mainIterationActivities } = iterationActivities;

const worker = await Worker.create({
  connection,
  namespace,
  taskQueue,
  workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
  activities: { ...activities, ...packActivities, ...mainIterationActivities },
  maxConcurrentActivityTaskExecutions: activityConcurrency,
});

const applyWorker = await Worker.create({
  connection,
  namespace,
  taskQueue: applyTaskQueue,
  activities: { applyIterationTask },
  maxConcurrentActivityTaskExecutions: 1,
});

console.log(
  `[worker] ready address=${address} namespace=${namespace} queue=${taskQueue} activityConcurrency=${activityConcurrency}`,
);
console.log(
  `[worker] apply queue ready queue=${applyTaskQueue} activityConcurrency=1`,
);

process.once("SIGINT", () => {
  void worker.shutdown();
  void applyWorker.shutdown();
});
process.once("SIGTERM", () => {
  void worker.shutdown();
  void applyWorker.shutdown();
});

await Promise.all([worker.run(), applyWorker.run()]);
await shutdownTelemetry();

function clampInt(
  value: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
