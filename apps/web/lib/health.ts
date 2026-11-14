import {
  createTemporalClient,
  taskQueue,
  temporalNamespace,
} from "@kit/workflow";
import { getStore } from "./store";

export interface HealthSnapshot {
  ok: boolean;
  db: "ok" | "error";
  temporal: "ok" | "error";
  worker: "ok" | "down" | "unknown";
  blobBackend: string;
  checkedAt: string;
  errors?: string[];
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function getHealth(): Promise<HealthSnapshot> {
  const errors: string[] = [];
  const store = await getStore();

  let db: HealthSnapshot["db"] = "error";
  try {
    await store.sql`select 1 as ok`;
    db = "ok";
  } catch (error) {
    errors.push(`db: ${messageOf(error)}`);
  }

  let temporal: HealthSnapshot["temporal"] = "error";
  let worker: HealthSnapshot["worker"] = "unknown";

  try {
    const connectionResult = await withTimeout(createTemporalClient(), 2500);

    if (connectionResult) {
      const { client, connection } = connectionResult;
      temporal = "ok";
      try {
        const description = await withTimeout(
          client.workflowService.describeTaskQueue({
            namespace: temporalNamespace,
            taskQueue: { name: taskQueue },
            taskQueueType: 1,
          }),
          2000,
        );
        worker =
          description && (description.pollers?.length ?? 0) > 0 ? "ok" : "down";
      } catch (error) {
        errors.push(`worker: ${messageOf(error)}`);
      } finally {
        await connection.close();
      }
    } else {
      errors.push("temporal: connection timeout");
    }
  } catch (error) {
    errors.push(`temporal: ${messageOf(error)}`);
  }

  return {
    ok: db === "ok" && temporal === "ok",
    db,
    temporal,
    worker,
    blobBackend: store.config.blobBackend,
    checkedAt: new Date().toISOString(),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
