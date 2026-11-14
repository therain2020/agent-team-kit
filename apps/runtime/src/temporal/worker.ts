import { fileURLToPath } from "node:url";
import {
  type EngineRunStatus,
  createDegradationGuard,
  guardedActivities,
  probeErrorStatus,
  reconcileIterationRuns,
  setActivityHeartbeat,
} from "@kit/engine";
import { initStore } from "@kit/store";
import { initTelemetry, shutdownTelemetry } from "@kit/telemetry";
import { applyTaskQueue, createTemporalClient } from "@kit/workflow";
import { Context } from "@temporalio/activity";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import * as iterationActivities from "./iteration-activities";
import * as packActivities from "./pack-activities";

initTelemetry({ serviceName: "kit-worker" });
setActivityHeartbeat(() => Context.current().heartbeat());

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
const engineStore = await initStore();
const guardedPackActivities = guardedActivities(
  createDegradationGuard(engineStore),
  packActivities,
);

const worker = await Worker.create({
  connection,
  namespace,
  taskQueue,
  workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
  activities: {
    ...activities,
    ...guardedPackActivities,
    ...mainIterationActivities,
  },
  maxConcurrentActivityTaskExecutions: activityConcurrency,
});

const applyWorker = await Worker.create({
  connection,
  namespace,
  taskQueue: applyTaskQueue,
  activities: { applyIterationTask },
  maxConcurrentActivityTaskExecutions: 1,
});

const temporalClient = await createTemporalClient();
const reconcileIntervalMs = clampInt(
  process.env.KIT_RECONCILE_INTERVAL_MS,
  10_000,
  3_600_000,
  60_000,
);
const reconcileProbe = {
  async describe(workflowId: string): Promise<EngineRunStatus> {
    try {
      const description = await temporalClient.client.workflow
        .getHandle(workflowId)
        .describe();
      return mapEngineStatus(description.status.name);
    } catch (error) {
      return probeErrorStatus(error);
    }
  },
};

async function runReconcile(): Promise<void> {
  try {
    const repaired = await reconcileIterationRuns({
      store: engineStore,
      probe: reconcileProbe,
    });
    if (repaired.length > 0) {
      console.log(`[reconciler] repaired ${repaired.length} run(s)`);
    }
  } catch (error) {
    console.error(
      `[reconciler] ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const reconcileTimer = setInterval(
  () => void runReconcile(),
  reconcileIntervalMs,
);
reconcileTimer.unref?.();
void runReconcile();

console.log(
  `[worker] ready address=${address} namespace=${namespace} queue=${taskQueue} activityConcurrency=${activityConcurrency}`,
);
console.log(
  `[worker] apply queue ready queue=${applyTaskQueue} activityConcurrency=1`,
);
console.log(`[reconciler] interval=${reconcileIntervalMs}ms`);

process.once("SIGINT", () => {
  clearInterval(reconcileTimer);
  void temporalClient.connection.close().catch(() => undefined);
  void worker.shutdown();
  void applyWorker.shutdown();
});
process.once("SIGTERM", () => {
  clearInterval(reconcileTimer);
  void temporalClient.connection.close().catch(() => undefined);
  void worker.shutdown();
  void applyWorker.shutdown();
});

await Promise.all([worker.run(), applyWorker.run()]);
await engineStore.close().catch(() => undefined);
await shutdownTelemetry();

function mapEngineStatus(name: string): EngineRunStatus {
  switch (name) {
    case "RUNNING":
      return "running";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELED":
      return "cancelled";
    case "TERMINATED":
      return "terminated";
    case "TIMED_OUT":
      return "timed_out";
    case "CONTINUED_AS_NEW":
      return "continued_as_new";
    default:
      return "unknown";
  }
}

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
