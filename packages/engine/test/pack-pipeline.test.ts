import type {
  PackRunInput,
  PackStageExecutionResult,
  PackStageSpec,
} from "@kit/workflow";
import { describe, expect, it } from "vitest";
import {
  type ApprovalOutcome,
  type PackPipelineActivities,
  type PackPipelineIo,
  runPackPipeline,
} from "../src/pack-pipeline";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  io: PackPipelineIo;
  started: string[];
  executeCalls: Array<{
    stage: string;
    inputText: string;
    inputArtifactIds?: string[];
  }>;
  statuses: string[];
  finishedRun: boolean;
  failReason: string | undefined;
  resolve(stage: string, text?: string): void;
  reject(stage: string, error: Error): void;
}

function harness(options: { auto?: string[] } = {}): Harness {
  const executions = new Map<string, Deferred<PackStageExecutionResult>>();
  const started: string[] = [];
  const executeCalls: Harness["executeCalls"] = [];
  const statuses: string[] = [];
  let finishedRun = false;
  let failReason: string | undefined;

  const activities: PackPipelineActivities = {
    async preparePackRun() {
      return;
    },
    executePackStage(input) {
      started.push(input.stageName);
      executeCalls.push({
        stage: input.stageName,
        inputText: input.inputText,
        ...(input.inputArtifactIds
          ? { inputArtifactIds: [...input.inputArtifactIds] }
          : {}),
      });
      if (options.auto?.includes(input.stageName)) {
        return Promise.resolve({
          artifactId: `art_${input.stageName}`,
          text: `out_${input.stageName}`,
          reused: false,
        });
      }
      const pending = deferred<PackStageExecutionResult>();
      executions.set(input.stageName, pending);
      return pending.promise;
    },
    async requestApproval() {
      return { required: false, runCostCny: 0 };
    },
    async finishPackRun() {
      finishedRun = true;
    },
    async failPackRun(input) {
      failReason = input.reason;
    },
    async setPackRunStatus(input) {
      statuses.push(input.status);
    },
    async deliverPackRun() {
      return;
    },
  };

  return {
    io: {
      activities,
      waitForApproval: async () => "approved" as ApprovalOutcome,
    },
    started,
    executeCalls,
    statuses,
    get finishedRun() {
      return finishedRun;
    },
    get failReason() {
      return failReason;
    },
    resolve(stage, text = `out_${stage}`) {
      const pending = executions.get(stage);
      if (!pending) {
        throw new Error(`stage ${stage} has not started`);
      }
      pending.resolve({
        artifactId: `art_${stage}`,
        text,
        reused: false,
      });
    },
    reject(stage, error) {
      const pending = executions.get(stage);
      if (!pending) {
        throw new Error(`stage ${stage} has not started`);
      }
      pending.reject(error);
    },
  };
}

function stage(id: string, extra: Partial<PackStageSpec> = {}): PackStageSpec {
  return {
    stageId: id,
    stageName: id,
    type: "agent",
    agentId: "echo",
    modelAlias: "deepseek-flash",
    instructions: "Echo the input.",
    ...extra,
  };
}

function runInput(
  stages: PackStageSpec[],
  overrides: Partial<PackRunInput> = {},
): PackRunInput {
  return {
    runId: "run_test",
    eventId: "evt_test",
    workspaceId: "default",
    workflowId: "wf",
    workflowVersion: "1",
    runMode: "DRY_RUN",
    initialInput: "root",
    stages,
    stub: true,
    ...overrides,
  };
}

function diamond(): PackStageSpec[] {
  return [
    stage("a"),
    stage("b", { inputsFromStageIds: ["a"] }),
    stage("c", { inputsFromStageIds: ["a"] }),
    stage("d", { inputsFromStageIds: ["b", "c"] }),
  ];
}

async function tick(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("pack pipeline DAG scheduling", () => {
  it("starts independent branches before either one finishes", async () => {
    const h = harness();
    const promise = runPackPipeline(runInput(diamond()), h.io);

    await waitFor(() => h.started.includes("a"), "stage a");
    expect(h.started).toEqual(["a"]);

    h.resolve("a", "A");
    await waitFor(
      () => h.started.includes("b") && h.started.includes("c"),
      "branches b and c",
    );
    expect(h.started).not.toContain("d");

    h.resolve("c", "C");
    await tick();
    expect(h.started).not.toContain("d");

    h.resolve("b", "B");
    await waitFor(() => h.started.includes("d"), "join stage d");
    h.resolve("d", "D");

    await expect(promise).resolves.toEqual({
      runId: "run_test",
      artifactIds: ["art_a", "art_b", "art_c", "art_d"],
    });
    expect(h.finishedRun).toBe(true);
  });

  it("respects the concurrency limit", async () => {
    const h = harness();
    const promise = runPackPipeline(
      runInput(diamond(), { maxConcurrency: 1 }),
      h.io,
    );

    await waitFor(() => h.started.includes("a"), "stage a");
    h.resolve("a", "A");

    await waitFor(() => h.started.includes("b"), "stage b");
    await tick();
    expect(h.started).not.toContain("c");

    h.resolve("b", "B");
    await waitFor(() => h.started.includes("c"), "stage c");
    await tick();
    expect(h.started).not.toContain("d");

    h.resolve("c", "C");
    await waitFor(() => h.started.includes("d"), "stage d");
    h.resolve("d", "D");

    await promise;
    expect(h.started).toEqual(["a", "b", "c", "d"]);
  });

  it("stops scheduling new stages after a failure and fails once", async () => {
    const h = harness();
    const promise = runPackPipeline(runInput(diamond()), h.io);

    await waitFor(() => h.started.includes("a"), "stage a");
    h.resolve("a", "A");
    await waitFor(
      () => h.started.includes("b") && h.started.includes("c"),
      "branches b and c",
    );

    h.reject("b", new Error("boom"));
    await tick();
    h.resolve("c", "C");

    await expect(promise).rejects.toThrow("boom");
    expect(h.finishedRun).toBe(false);
    expect(h.started).not.toContain("d");
  });

  it("joins multiple inputs in dependency order", async () => {
    const h = harness({ auto: ["a", "b", "c", "d"] });
    const result = await runPackPipeline(runInput(diamond()), h.io);

    const join = h.executeCalls.find((call) => call.stage === "d");
    expect(join?.inputText).toBe("out_b\n\n---\n\nout_c");
    expect(join?.inputArtifactIds).toEqual(["art_b", "art_c"]);
    expect(result.artifactIds).toEqual(["art_a", "art_b", "art_c", "art_d"]);
  });

  it("keeps the run paused until the last pending approval resolves", async () => {
    const h = harness();
    const decisions = [
      deferred<ApprovalOutcome>(),
      deferred<ApprovalOutcome>(),
    ];
    let approvalIndex = 0;
    h.io.activities.requestApproval = async (input) => ({
      required: true,
      requestId: `req_${input.stageId}`,
      expiresAt: new Date().toISOString(),
      runCostCny: 0,
    });
    h.io.waitForApproval = () => {
      const decision = decisions[approvalIndex];
      approvalIndex += 1;
      if (!decision) {
        throw new Error("unexpected approval");
      }
      return decision.promise;
    };

    const approval = {
      mode: "required" as const,
      position: "before" as const,
      riskClass: "low" as const,
      ttlMs: 30_000,
    };
    const stages = [
      stage("a"),
      stage("b", { inputsFromStageIds: ["a"], approval }),
      stage("c", { inputsFromStageIds: ["a"], approval }),
    ];
    const promise = runPackPipeline(runInput(stages), h.io);

    await waitFor(() => h.started.includes("a"), "root stage a");
    h.resolve("a", "A");

    await waitFor(
      () => h.statuses.filter((status) => status === "paused").length === 2,
      "two paused approvals",
    );
    expect(h.started).toEqual(["a"]);

    decisions[0]?.resolve("approved");
    await waitFor(() => h.started.length === 2, "first branch executing");
    expect(h.statuses).not.toContain("running");

    decisions[1]?.resolve("approved");
    await waitFor(
      () => h.started.length === 3 && h.statuses.includes("running"),
      "both branches executing",
    );
    h.resolve("b", "B");
    h.resolve("c", "C");

    await promise;
  });
});
