import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initStore, listOps, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRunRecoveryIntegrity } from "../src/recovery";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function sqliteStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-recovery-"));
  dirs.push(dir);
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: dir,
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
  closers.push(() => store.close());
  return store;
}

type Store = Awaited<ReturnType<typeof sqliteStore>>;

async function seedRun(store: Store, runId: string) {
  const now = new Date().toISOString();
  await store.runs.create({
    runId,
    eventId: `evt_${runId}`,
    workspaceId: "default",
    workflowId: "recovery-demo",
    workflowVersion: "1.0",
    runMode: "DRY_RUN",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
  return store.artifactService.publish({
    workspaceId: "default",
    content: new TextEncoder().encode("recovered artifact"),
    producer: {
      agentId: "echo",
      agentVersion: "1.0.0",
      promptHash: "hash",
      modelId: "stub",
    },
    inputs: [],
    runId,
    stageId: `${runId}:a`,
    runMode: "DRY_RUN",
    cost: { currency: "CNY", amount: 0, tokens: 0 },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });
}

describe("run recovery integrity gate (61 §3.5)", () => {
  it("records a verified audit entry and lets the run continue", async () => {
    const store = await sqliteStore();
    const runId = "run_recovery_ok";
    await seedRun(store, runId);

    const outcome = await verifyRunRecoveryIntegrity({
      store,
      runId,
      workspaceId: "default",
      owner: "worker-a",
      leaseVersion: 2,
    });

    expect(outcome.action).toBe("continue");
    expect(outcome.ok).toBe(true);
    expect(outcome.report.checked).toBe(1);

    const ops = await listOps(store, { entityKind: "run", entityId: runId });
    expect(ops.some((op) => op.op === "run.recovery.verified")).toBe(true);
    expect((await store.runs.get(runId))?.status).toBe("running");
  });

  it("stops the run and audits when an artifact no longer verifies", async () => {
    const store = await sqliteStore();
    const runId = "run_recovery_corrupt";
    const published = await seedRun(store, runId);
    await writeFile(
      path.join(store.config.blobRoot, published.blob.storageKey),
      new TextEncoder().encode("corrupted"),
    );

    const outcome = await verifyRunRecoveryIntegrity({
      store,
      runId,
      workspaceId: "default",
      owner: "worker-b",
      leaseVersion: 2,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.action).toBe("failed");
    expect(outcome.failureReason).toMatch(
      /recovery integrity verification failed/,
    );
    expect((await store.runs.get(runId))?.status).toBe("failed");

    const ops = await listOps(store, { entityKind: "run", entityId: runId });
    const failed = ops.find((op) => op.op === "run.recovery.failed");
    expect(failed).toBeDefined();
    expect(failed?.payload).toMatchObject({ checked: 1 });
  });
});
