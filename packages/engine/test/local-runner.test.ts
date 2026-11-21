import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findApprovalRequest, recordDecision } from "@kit/manager";
import { initStore, loadStoreConfig } from "@kit/store";
import type { PackRunInput, PackStageSpec } from "@kit/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueLocalRun, runPackWorkflowLocal } from "../src/local-runner";
import { closeEngineStore } from "../src/pack-activities";

let dir: string;
let env: Record<string, string>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "kit-engine-"));
  env = {
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: dir,
    KIT_BLOB_ROOT: path.join(dir, "blobs"),
  };
  Object.assign(process.env, env);
});

afterAll(async () => {
  await closeEngineStore();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function stage(
  id: string,
  approval?: PackStageSpec["approval"],
): PackStageSpec & { stageName: string } {
  return {
    stageId: id,
    stageName: id,
    type: "agent",
    agentId: "echo",
    modelAlias: "deepseek-flash",
    instructions: "Echo the input.",
    ...(approval ? { approval } : {}),
  };
}

function input(
  runId: string,
  stages: Array<PackStageSpec & { stageName: string }>,
): PackRunInput {
  return {
    runId,
    eventId: `evt_${runId}`,
    workspaceId: "default",
    workflowId: "local-demo",
    workflowVersion: "1.0",
    runMode: "DRY_RUN",
    initialInput: "hello local engine",
    stages: stages.map((item) => ({
      ...item,
      stageId: `${runId}:${item.stageName}`,
    })),
    stub: true,
  };
}

async function storeFor(envVars: Record<string, string>) {
  return initStore(loadStoreConfig(envVars));
}

describe("local pack runner", () => {
  it("runs a two-stage linear workflow with committed artifacts", async () => {
    const store = await storeFor(env);
    try {
      const runId = "run_engine_linear";
      const result = await runPackWorkflowLocal(
        input(runId, [stage("draft"), stage("polish")]),
        { store, pollMs: 10 },
      );

      expect(result.artifactIds).toHaveLength(2);
      const run = await store.runs.get(runId);
      expect(run?.status).toBe("succeeded");
      const stages = await store.stages.listByRun(runId);
      expect(stages.map((item) => item.status)).toEqual([
        "succeeded",
        "succeeded",
      ]);
      const artifacts = await store.artifactStore.listByRun(runId);
      // Every stage writes its output plus the 30 §3.3 dossier
      // (instructions + transcript): 2 stages × 3 artifacts.
      expect(artifacts).toHaveLength(6);
      const manifests = await Promise.all(
        artifacts.map((artifact) => store.manifests.get(artifact.manifestId)),
      );
      const stageIds = manifests
        .map((manifest) => manifest?.stageId ?? "")
        .sort();
      expect(stageIds).toEqual([
        `${runId}:draft`,
        `${runId}:draft:instructions`,
        `${runId}:draft:transcript`,
        `${runId}:polish`,
        `${runId}:polish:instructions`,
        `${runId}:polish:transcript`,
      ]);
    } finally {
      await store.close();
    }
  });

  it("pauses before a stage and resumes after an approve decision", async () => {
    const store = await storeFor(env);
    try {
      const runId = "run_engine_approve";
      const approval = {
        mode: "required" as const,
        position: "before" as const,
        riskClass: "low" as const,
        ttlMs: 30_000,
      };

      const promise = runPackWorkflowLocal(
        input(runId, [stage("draft", approval)]),
        { store, pollMs: 10 },
      );

      const requestId = await waitForApprovalRequest(store, runId);
      await recordDecision(store, runId, "approve", "ship it", { requestId });
      const result = await promise;

      expect(result.artifactIds).toHaveLength(1);
      expect((await store.runs.get(runId))?.status).toBe("succeeded");
    } finally {
      await store.close();
    }
  }, 30_000);

  it("merges a duplicate enqueue and stamps the priority class", async () => {
    const store = await storeFor(env);
    try {
      const runId = "run_engine_duplicate";
      const queued = {
        ...input(runId, [stage("draft")]),
        workspaceId: "alpha",
      };
      const first = await enqueueLocalRun(queued, store);
      const second = await enqueueLocalRun(queued, store);

      expect(second.requestId).toBe(first.requestId);
      const record = await store.runRequests.find(runId);
      const payload = JSON.parse(record?.payload ?? "{}") as {
        priority?: string;
        workspaceId?: string;
      };
      expect(payload.workspaceId).toBe("alpha");
      // DRY_RUN is background work, so the derived class is P3.
      expect(payload.priority).toBe("P3");
      // The claim column mirrors the payload so the fair scheduler and the
      // admission gate can rank the row without parsing JSON.
      expect(record?.priority).toBe("P3");
      expect(second.admission).toBe("merge");
    } finally {
      await store.close();
    }
  });

  it("fails the run when the approval is aborted", async () => {
    const store = await storeFor(env);
    try {
      const runId = "run_engine_abort";
      const approval = {
        mode: "required" as const,
        position: "before" as const,
        riskClass: "high" as const,
        ttlMs: 30_000,
      };

      // Attach the rejection handler at creation: the pipeline can reject
      // while the test is still polling for the approval request, and Node
      // reports that window as an unhandled rejection that fails the run.
      const outcome = runPackWorkflowLocal(
        input(runId, [stage("draft", approval)]),
        { store, pollMs: 10 },
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      const requestId = await waitForApprovalRequest(store, runId);
      await recordDecision(store, runId, "abort", "not now", { requestId });

      const settled = await outcome;
      expect(settled.ok).toBe(false);
      if (!settled.ok) {
        expect(settled.error).toBeInstanceOf(Error);
        expect((settled.error as Error).message).toContain("approval aborted");
      }
      expect((await store.runs.get(runId))?.status).toBe("failed");
    } finally {
      await store.close();
    }
  }, 30_000);
});

async function waitForApprovalRequest(
  store: Awaited<ReturnType<typeof initStore>>,
  runId: string,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const approval = await findApprovalRequest(store, runId);
    if (approval) {
      return approval.requestId;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("approval request did not appear");
}
