import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EventEnvelope, Run, Stage } from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import { ensureSchema } from "../src/migrate";
import { listOps } from "../src/op-log";
import { initStore } from "../src/store";
import type { WriteLease } from "../src/write-fencing";
import { VersionConflictError } from "../src/write-fencing";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function localConfig() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-fencing-"));
  dirs.push(dir);
  return loadStoreConfig({
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: dir,
    KIT_BLOB_ROOT: path.join(dir, "blobs"),
  });
}

function event(runId: string): EventEnvelope {
  const now = new Date().toISOString();
  return {
    eventId: `evt_${runId}`,
    type: "demo.event.received",
    schemaVersion: "1.0",
    occurredAt: now,
    receivedAt: now,
    workspaceId: "default",
    idempotencyKey: `idem-${runId}`,
    traceId: `trace-${runId}`,
    payloadRef: "inline:{}",
  };
}

function run(runId: string): Run {
  const now = new Date().toISOString();
  return {
    runId,
    eventId: `evt_${runId}`,
    workspaceId: "default",
    workflowId: "demo",
    workflowVersion: "1.0",
    runMode: "DRY_RUN",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
}

function stage(runId: string): Stage {
  return {
    stageId: `${runId}:echo`,
    runId,
    name: "echo",
    status: "pending",
  };
}

async function storeFor() {
  const store = await initStore(await localConfig());
  closers.push(() => store.close());
  return store;
}

async function claimRun(
  store: Awaited<ReturnType<typeof initStore>>,
  runId: string,
  requestId: string,
) {
  const now = new Date().toISOString();
  await store.events.insert(event(runId));
  await store.runs.create(run(runId));
  await store.stages.create(stage(runId));
  await store.runRequests.enqueue({
    requestId,
    runId,
    workspaceId: "default",
    workflowId: "demo",
    kind: "pack_run",
    payload: JSON.stringify({ runId }),
    createdAt: now,
    updatedAt: now,
  });
}

describe("write fencing (61 §3.5)", () => {
  it("rejects writes from a worker whose lease was superseded", async () => {
    const store = await storeFor();
    const runId = "run_fenced_1";
    const requestId = "rrq_fenced_1";
    await claimRun(store, runId, requestId);

    const claimedA = await store.runRequests.claimNext(
      "worker-a",
      new Date(),
      60_000,
    );
    expect(claimedA?.leaseVersion).toBe(1);
    const leaseA: WriteLease = {
      requestId,
      owner: "worker-a",
      leaseVersion: claimedA?.leaseVersion ?? 1,
    };

    // The current owner can write.
    await store.runs.updateStatus(runId, "paused", new Date().toISOString(), {
      lease: leaseA,
    });
    await store.stages.updateStatus(
      stage(runId).stageId,
      "running",
      { startedAt: new Date().toISOString() },
      { lease: leaseA },
    );
    expect(
      (
        await store.runRequests.heartbeat(
          requestId,
          "worker-a",
          new Date(),
          leaseA.leaseVersion,
        )
      )?.leaseVersion,
    ).toBe(1);

    // A's heartbeat expires and B re-claims the request; the fencing token
    // moves to 2, so every subsequent A write must affect 0 rows.
    const claimedB = await store.runRequests.claimNext(
      "worker-b",
      new Date(Date.now() + 120_000),
      60_000,
    );
    expect(claimedB?.claimedBy).toBe("worker-b");
    expect(claimedB?.leaseVersion).toBe(2);

    await expect(
      store.runRequests.heartbeat(requestId, "worker-a", new Date(), 1),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await expect(
      store.runs.updateStatus(runId, "succeeded", new Date().toISOString(), {
        lease: leaseA,
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await expect(
      store.stages.updateStatus(stage(runId).stageId, "succeeded", undefined, {
        lease: leaseA,
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await expect(
      store.runRequests.finish(requestId, "done", undefined, leaseA),
    ).rejects.toBeInstanceOf(VersionConflictError);

    // A's rejected writes left B's state untouched.
    expect((await store.runs.get(runId))?.status).toBe("paused");
    expect((await store.stages.listByRun(runId))[0]?.status).toBe("running");
    expect((await store.runRequests.find(runId))?.claimedBy).toBe("worker-b");

    // B can advance the run and finish the request.
    const leaseB: WriteLease = {
      requestId,
      owner: "worker-b",
      leaseVersion: claimedB?.leaseVersion ?? 2,
    };
    await store.runs.updateStatus(
      runId,
      "succeeded",
      new Date().toISOString(),
      { lease: leaseB },
    );
    await store.stages.updateStatus(
      stage(runId).stageId,
      "succeeded",
      { finishedAt: new Date().toISOString() },
      { lease: leaseB },
    );
    await store.runRequests.finish(requestId, "done", undefined, leaseB);

    expect((await store.runs.get(runId))?.status).toBe("succeeded");
    expect((await store.runRequests.find(runId))?.status).toBe("done");

    const runOps = await listOps(store, {
      workspaceId: "default",
      entityKind: "run",
      entityId: runId,
    });
    const stageOps = await listOps(store, {
      workspaceId: "default",
      entityKind: "stage",
      entityId: stage(runId).stageId,
    });
    const requestOps = await listOps(store, {
      workspaceId: "default",
      entityKind: "run_request",
      entityId: requestId,
    });
    expect(runOps.some((op) => op.op === "run.conflict")).toBe(true);
    expect(stageOps.some((op) => op.op === "stage.conflict")).toBe(true);
    expect(requestOps.some((op) => op.op === "run_request.conflict")).toBe(
      true,
    );
  }, 60_000);

  it("surfaces a typed, retryable conflict for stale version CAS", async () => {
    const store = await storeFor();
    const runId = "run_cas_1";
    await store.events.insert(event(runId));
    await store.runs.create(run(runId));
    await store.stages.create(stage(runId));

    expect(await store.stages.getVersion(stage(runId).stageId)).toBe(0);
    await store.stages.updateStatus(stage(runId).stageId, "running", {
      startedAt: new Date().toISOString(),
    });
    expect(await store.stages.getVersion(stage(runId).stageId)).toBe(1);

    const staleError = await store.stages
      .update({ ...stage(runId), status: "succeeded" }, { expectedVersion: 0 })
      .catch((error: unknown) => error);
    expect(staleError).toBeInstanceOf(VersionConflictError);
    const conflict = staleError as VersionConflictError;
    expect(conflict.code).toBe("conflict");
    expect(conflict.retryable).toBe(true);
    expect(conflict.detail.reason).toBe("version_mismatch");
    expect(conflict.detail.currentVersion).toBe(1);

    // The failed CAS left the row untouched, and a fresh version succeeds.
    expect((await store.stages.listByRun(runId))[0]?.status).toBe("running");
    await store.stages.update(
      { ...stage(runId), status: "succeeded" },
      { expectedVersion: 1 },
    );
    expect((await store.stages.listByRun(runId))[0]?.status).toBe("succeeded");
    expect(await store.stages.getVersion(stage(runId).stageId)).toBe(2);

    expect(await store.runs.getVersion(runId)).toBe(0);
    await store.runs.updateStatus(runId, "paused", new Date().toISOString(), {
      expectedVersion: 0,
    });
    expect(await store.runs.getVersion(runId)).toBe(1);
    await expect(
      store.runs.updateStatus(runId, "failed", new Date().toISOString(), {
        expectedVersion: 0,
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect((await store.runs.get(runId))?.status).toBe("paused");

    const ops = await listOps(store, {
      workspaceId: "default",
      entityKind: "stage",
      entityId: stage(runId).stageId,
    });
    expect(ops.some((op) => op.op === "stage.conflict")).toBe(true);
  }, 60_000);

  it("re-applying ensureSchema tolerates the new columns", async () => {
    const config = await localConfig();
    const store = await initStore(config);
    closers.push(() => store.close());

    await ensureSchema(store.exec, store.driver);

    const rows = await store.sql<Array<{ name: string }>>`
      PRAGMA table_info(run_requests)
    `;
    const columns = rows.map((row) => row.name);
    expect(columns).toContain("lease_version");
    const runColumns = (
      await store.sql<Array<{ name: string }>>`PRAGMA table_info(runs)`
    ).map((row) => row.name);
    expect(runColumns).toContain("version");
  }, 60_000);
});
