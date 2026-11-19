import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  VersionConflictError,
  type WriteLease,
  initStore,
  listOps,
  loadStoreConfig,
} from "@kit/store";
import type { IterationInput } from "@kit/workflow";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { IterationPipelineActivities } from "../src/iteration-pipeline";
import { enqueueLocalIteration, startLocalRunner } from "../src/local-runner";
import { closeEngineStore, setPackRunStatus } from "../src/pack-activities";
import { currentWriteLease, withWriteLease } from "../src/write-lease";

let dir: string;
let env: Record<string, string>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "kit-engine-fencing-"));
  env = {
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: dir,
    KIT_BLOB_ROOT: path.join(dir, "blobs"),
  };
  // pack-activities resolves its store from the process environment.
  Object.assign(process.env, env);
});

afterEach(async () => {
  await closeEngineStore();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function storeFor() {
  return initStore(loadStoreConfig(env));
}

function iterationInput(iterationId: string): IterationInput {
  return {
    iterationId,
    workspaceId: "default",
    packDir: "packs/self-improve",
    goal: "local iteration",
    maxTasks: 1,
    maxRepair: 0,
    runMode: "DRY_RUN",
    applyMode: "none",
    stub: true,
  };
}

function fakeActivities(
  seen: Array<WriteLease | null>,
): IterationPipelineActivities {
  return {
    planIteration: async (input) => {
      seen.push(currentWriteLease());
      return {
        plan: {
          goal: input.goal,
          summary: "plan",
          tasks: [
            {
              id: "one",
              domain: "docs",
              goal: "update docs",
              acceptance: "docs updated",
              filesHint: [],
              risk: "low",
              dependsOn: [],
            },
          ],
        },
        artifactId: "art_plan",
        tokens: 0,
        costCny: 0,
      };
    },
    runIterationCoder: async (job) => ({
      taskId: job.task.id,
      coder: "command",
      ok: true,
      summary: "done",
      changedFiles: [],
      diffArtifactId: "art_diff",
      resultArtifactId: "art_result",
      transcriptArtifactId: "art_tx",
      sandboxDir: path.join(dir, "sandbox"),
      baselineSha: "abc123",
      sandboxMode: "copy",
      tokens: 0,
    }),
    verifyIterationTask: async (job) => ({
      taskId: job.task.id,
      pass: true,
      feedback: "ok",
      checks: [],
      artifactId: "art_verify",
    }),
    classifyIterationTask: async (job) => ({
      taskId: job.task.id,
      risk: job.plannedRisk,
      reasons: [],
      forbidden: false,
    }),
    applyIterationTask: async (job) => ({
      taskId: job.task.id,
      applied: false,
      status: "skipped",
      reason: "dry run",
      ticketId: "tkt_1",
      baseSha: job.baselineSha,
      artifactId: "art_apply",
    }),
    cleanupIterationTask: async () => undefined,
    reportIteration: async () => ({
      reportArtifactId: "art_report",
      fitnessArtifactId: "art_fitness",
      status: "succeeded" as const,
    }),
    failIterationActivity: async () => undefined,
  };
}

async function waitFor<T>(check: () => Promise<T | null>): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met in time");
}

describe("engine write fencing", () => {
  it("fences pack-run status writes behind the claim lease", async () => {
    const store = await storeFor();
    try {
      const runId = "run_engine_fence";
      const requestId = "rrq_engine_fence";
      const now = new Date().toISOString();
      await store.events.insert({
        eventId: `evt_${runId}`,
        type: "demo.event.received",
        schemaVersion: "1.0",
        occurredAt: now,
        receivedAt: now,
        workspaceId: "default",
        idempotencyKey: `idem-${runId}`,
        traceId: `trace-${runId}`,
        payloadRef: "inline:{}",
      });
      await store.runs.create({
        runId,
        eventId: `evt_${runId}`,
        workspaceId: "default",
        workflowId: "demo",
        workflowVersion: "1.0",
        runMode: "DRY_RUN",
        status: "running",
        createdAt: now,
        updatedAt: now,
      });
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

      const claimedA = await store.runRequests.claimNext(
        "worker-a",
        new Date(),
        60_000,
      );
      const leaseA: WriteLease = {
        requestId,
        owner: "worker-a",
        leaseVersion: claimedA?.leaseVersion ?? 1,
      };
      await withWriteLease(leaseA, () =>
        setPackRunStatus({ runId, status: "paused" }),
      );
      expect((await store.runs.get(runId))?.status).toBe("paused");

      const claimedB = await store.runRequests.claimNext(
        "worker-b",
        new Date(Date.now() + 120_000),
        60_000,
      );
      expect(claimedB?.leaseVersion).toBe(2);

      await expect(
        withWriteLease(leaseA, () =>
          setPackRunStatus({ runId, status: "running" }),
        ),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect((await store.runs.get(runId))?.status).toBe("paused");

      const leaseB: WriteLease = {
        requestId,
        owner: "worker-b",
        leaseVersion: claimedB?.leaseVersion ?? 2,
      };
      await withWriteLease(leaseB, () =>
        setPackRunStatus({ runId, status: "running" }),
      );
      expect((await store.runs.get(runId))?.status).toBe("running");

      const ops = await listOps(store, {
        workspaceId: "default",
        entityKind: "run",
        entityId: runId,
      });
      expect(ops.some((op) => op.op === "run.conflict")).toBe(true);
      expect(
        ops.some(
          (op) =>
            op.op === "run.conflict" &&
            (op.payload as { leaseVersion?: number }).leaseVersion === 1,
        ),
      ).toBe(true);
    } finally {
      await store.close();
    }
  }, 60_000);

  it("runs claimed work under its lease and clears it afterwards", async () => {
    const store = await storeFor();
    const seen: Array<WriteLease | null> = [];
    const stop = startLocalRunner({
      store,
      owner: "worker-local",
      tickMs: 20,
      iterationActivities: fakeActivities(seen),
    });
    try {
      const request = await enqueueLocalIteration(
        iterationInput("it_engine_lease"),
        store,
      );
      await waitFor(async () => {
        const found = await store.runRequests.find("it_engine_lease");
        return found?.status === "done" ? found : null;
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({
        requestId: request.requestId,
        owner: "worker-local",
        leaseVersion: 1,
      });
      expect(currentWriteLease()).toBeNull();
    } finally {
      stop();
      await store.close();
    }
  }, 30_000);
});
