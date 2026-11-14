import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initStore, loadStoreConfig } from "@kit/store";
import type { IterationInput } from "@kit/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IterationPipelineActivities } from "../src/iteration-pipeline";
import { enqueueLocalIteration, startLocalRunner } from "../src/local-runner";

let dir: string;
let env: Record<string, string>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "kit-iteration-runner-"));
  env = {
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: dir,
    KIT_BLOB_ROOT: path.join(dir, "blobs"),
  };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

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
  log: string[],
  cancel = false,
): IterationPipelineActivities {
  return {
    planIteration: async () => {
      log.push("plan");
      return {
        plan: {
          goal: "local iteration",
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
      changedFiles: ["README.md"],
      diffArtifactId: "art_diff",
      resultArtifactId: "art_result",
      transcriptArtifactId: "art_tx",
      sandboxDir: path.join(dir, "sandbox"),
      baselineSha: "abc123",
      sandboxMode: "copy",
      tokens: 1,
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
    reportIteration: async (job) => {
      log.push("report");
      return {
        reportArtifactId: "art_report",
        fitnessArtifactId: "art_fitness",
        status: "succeeded" as const,
      };
    },
    failIterationActivity: async (job) => {
      log.push(`fail:${job.error}`);
    },
    isIterationCancelled: async () => cancel,
    cancelIteration: async () => {
      log.push("cancel");
    },
  };
}

async function storeFor(envVars: Record<string, string>) {
  return initStore(loadStoreConfig(envVars));
}

async function waitFor<T>(
  check: () => Promise<T | null | undefined>,
): Promise<T> {
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

describe("local iteration runner", () => {
  it("claims an iteration request, runs the pipeline, and finishes it", async () => {
    const store = await storeFor(env);
    const log: string[] = [];
    const stop = startLocalRunner({
      store,
      tickMs: 20,
      iterationActivities: fakeActivities(log),
    });
    try {
      const request = await enqueueLocalIteration(
        iterationInput("it_local_done"),
        store,
      );
      expect((await store.runRequests.find("it_local_done"))?.kind).toBe(
        "iteration",
      );
      const done = await waitFor(async () => {
        const found = await store.runRequests.find("it_local_done");
        return found?.status === "done" ? found : null;
      });
      expect(done.requestId).toBe(request.requestId);
      expect(log).toEqual(["plan", "report"]);
    } finally {
      stop();
      await store.close();
    }
  }, 30_000);

  it("finishes the request as cancelled when the operator aborts", async () => {
    const store = await storeFor(env);
    const log: string[] = [];
    const stop = startLocalRunner({
      store,
      tickMs: 20,
      iterationActivities: fakeActivities(log, true),
    });
    try {
      await enqueueLocalIteration(iterationInput("it_local_cancel"), store);
      const cancelled = await waitFor(async () => {
        const found = await store.runRequests.find("it_local_cancel");
        return found?.status === "cancelled" ? found : null;
      });
      expect(cancelled.status).toBe("cancelled");
      expect(log).toEqual(["plan", "cancel"]);
    } finally {
      stop();
      await store.close();
    }
  }, 30_000);

  it("does not re-run an iteration that already reached a terminal state", async () => {
    const store = await storeFor(env);
    const now = new Date().toISOString();
    await store.sql`
      INSERT INTO iteration_runs (
        iteration_id, workflow_id, workspace_id, goal, run_mode, apply_mode,
        status, phase, started_at, updated_at
      ) VALUES (
        'it_local_terminal', 'iteration-it_local_terminal', 'default',
        'local iteration', 'DRY_RUN', 'none', 'succeeded', 'done', ${now}, ${now}
      )
    `;
    const log: string[] = [];
    const stop = startLocalRunner({
      store,
      tickMs: 20,
      iterationActivities: fakeActivities(log),
    });
    try {
      await enqueueLocalIteration(iterationInput("it_local_terminal"), store);
      const done = await waitFor(async () => {
        const found = await store.runRequests.find("it_local_terminal");
        return found?.status === "done" ? found : null;
      });
      expect(done.status).toBe("done");
      expect(log).toEqual([]);
    } finally {
      stop();
      await store.close();
    }
  }, 30_000);
});
