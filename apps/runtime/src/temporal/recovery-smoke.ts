import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { newId } from "@kit/core";
import { initStore } from "@kit/store";
import {
  createTemporalClient,
  taskQueue,
  temporalAddress,
  temporalNamespace,
} from "./client";
import type { DemoInput } from "./types";
import { demoWorkflow } from "./workflows";

const workerEntry = path.resolve("apps/runtime/src/temporal/worker.ts");
const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
const runId = newId("run");
const workflowId = `demo-${runId}`;

let activeWorker: ChildProcess | undefined;

function startWorker(): ChildProcess {
  activeWorker = spawn(process.execPath, [tsxCli, workerEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      KIT_TEMPORAL_ADDRESS: temporalAddress,
      KIT_TEMPORAL_NAMESPACE: temporalNamespace,
      KIT_TASK_QUEUE: taskQueue,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return activeWorker;
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("worker did not become ready")),
      60000,
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      if (chunk.toString().includes("[worker] ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("exit", (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`worker exited early: ${code}`));
    });
  });
}

function killWorker(child: ChildProcess): void {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs = 30000,
): Promise<T> {
  const start = Date.now();

  while (true) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function main(): Promise<void> {
  const store = await initStore();
  const { client, connection } = await createTemporalClient();

  let worker = startWorker();
  await waitForReady(worker);
  console.log("[smoke] worker #1 ready");

  const now = new Date().toISOString();
  const event = {
    eventId: newId("evt"),
    type: "demo.event.received",
    schemaVersion: "1.0" as const,
    occurredAt: now,
    receivedAt: now,
    workspaceId: "default",
    idempotencyKey: `smoke:${runId}`,
    traceId: newId("trc"),
    payloadRef: "memory://smoke",
  };
  await store.events.insert(event);

  const input: DemoInput = {
    runId,
    eventId: event.eventId,
    workspaceId: "default",
    sleepMs: 6000,
  };

  const handle = await client.workflow.start(demoWorkflow, {
    taskQueue,
    workflowId,
    args: [input],
  });
  console.log(`[smoke] started ${workflowId}`);

  await waitFor(async () => {
    const artifacts = await store.artifactStore.listByRun(runId);
    return artifacts.length >= 2 ? artifacts : null;
  });
  console.log("[smoke] stage-2 artifact committed; killing worker");

  killWorker(worker);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const description = await handle.describe();
  console.log(`[smoke] workflow status after kill: ${description.status.name}`);
  if (description.status.name !== "RUNNING") {
    throw new Error(`expected RUNNING, got ${description.status.name}`);
  }

  worker = startWorker();
  await waitForReady(worker);
  console.log("[smoke] worker #2 ready; waiting for recovery");

  const result = await Promise.race([
    handle.result(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("workflow result timeout")), 90000),
    ),
  ]);

  const run = await waitFor(async () => {
    const current = await store.runs.get(runId);
    return current?.status === "succeeded" ? current : null;
  });
  const artifacts = await store.artifactStore.listByRun(runId);

  if (artifacts.length !== 2) {
    throw new Error(`expected 2 artifacts, got ${artifacts.length}`);
  }

  console.log(
    `[smoke] PASS run=${run.status} artifacts=${artifacts.length} result=${JSON.stringify(result)}`,
  );

  killWorker(worker);
  await connection.close();
  await store.sql.end();
  process.exit(0);
}

main().catch((error) => {
  if (activeWorker) {
    killWorker(activeWorker);
  }
  console.error("[smoke] FAIL", error);
  process.exit(1);
});
