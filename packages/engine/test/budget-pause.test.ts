import type {
  PackRunInput,
  PackStageExecutionInput,
  PackStageExecutionResult,
  PreparePackRunInput,
  RequestApprovalInput,
  RequestApprovalResult,
} from "@kit/workflow";
import { describe, expect, it, vi } from "vitest";
import {
  type PackPipelineActivities,
  runPackPipeline,
} from "../src/pack-pipeline";

function runInput(): PackRunInput {
  return {
    runId: "run_budget_1",
    eventId: "evt_budget_1",
    workspaceId: "default",
    workflowId: "wf",
    workflowVersion: "1",
    runMode: "DRY_RUN",
    initialInput: "input",
    stages: [
      {
        stageId: "run_budget_1:s1",
        stageName: "s1",
        type: "agent",
        agentId: "writer",
      },
    ],
    stub: true,
  };
}

function activities(overrides: {
  executeResults: PackStageExecutionResult[];
  approval?: RequestApprovalResult;
}): {
  activities: PackPipelineActivities;
  execute: ReturnType<typeof vi.fn>;
  requestApproval: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
} {
  const queue = [...overrides.executeResults];
  const execute = vi.fn(
    async (
      _input: PackStageExecutionInput,
    ): Promise<PackStageExecutionResult> => {
      const next = queue.shift();
      if (!next) {
        throw new Error("no execute result queued");
      }
      return next;
    },
  );
  const requestApproval = vi.fn(
    async (_input: RequestApprovalInput): Promise<RequestApprovalResult> =>
      overrides.approval ?? {
        required: true,
        requestId: "apr_1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        runCostCny: 0,
      },
  );
  const setStatus = vi.fn(
    async (_input: { runId: string; status: "paused" | "running" }) =>
      undefined,
  );
  const fail = vi.fn(
    async (_input: { runId: string; reason: string }) => undefined,
  );
  const finish = vi.fn(async (_input: { runId: string }) => undefined);
  const activities: PackPipelineActivities = {
    preparePackRun: vi.fn(async (_input: PreparePackRunInput) => undefined),
    executePackStage: execute,
    requestApproval,
    finishPackRun: finish,
    failPackRun: fail,
    setPackRunStatus: setStatus,
    deliverPackRun: vi.fn(async () => undefined),
  };
  return {
    activities,
    execute,
    requestApproval,
    setStatus,
    fail,
    finish,
  };
}

describe("pack pipeline budget pause", () => {
  it("pauses, requests a budget approval, and resumes the same stage", async () => {
    const fake = activities({
      executeResults: [
        {
          artifactId: "",
          text: "",
          reused: false,
          budgetPaused: true,
          budgetSummary: "run budget reached",
          blockingBudgetId: "bdg_1",
        },
        {
          artifactId: "",
          text: "",
          reused: false,
          budgetPaused: true,
          budgetSummary: "run budget reached",
          blockingBudgetId: "bdg_1",
        },
        { artifactId: "art_1", text: "ok", reused: false },
      ],
    });

    const result = await runPackPipeline(runInput(), {
      activities: fake.activities,
      waitForApproval: vi.fn(async () => "approved" as const),
    });

    expect(result.artifactIds).toEqual(["art_1"]);
    expect(fake.execute).toHaveBeenCalledTimes(3);
    expect(fake.requestApproval).toHaveBeenCalledTimes(1);
    expect(fake.requestApproval.mock.calls[0]?.[0].requestType).toBe(
      "budget_exceeded",
    );
    expect(fake.setStatus.mock.calls.map((call) => call[0].status)).toEqual([
      "paused",
      "running",
    ]);
    expect(fake.fail).not.toHaveBeenCalled();
    expect(fake.finish).toHaveBeenCalledTimes(1);
  });

  it("fails when the stage is still over budget after approval", async () => {
    const fake = activities({
      executeResults: [
        {
          artifactId: "",
          text: "",
          reused: false,
          budgetPaused: true,
          budgetSummary: "run budget reached",
        },
        {
          artifactId: "",
          text: "",
          reused: false,
          budgetPaused: true,
          budgetSummary: "run budget reached",
        },
        {
          artifactId: "",
          text: "",
          reused: false,
          budgetPaused: true,
          budgetSummary: "still over",
        },
      ],
    });

    await expect(
      runPackPipeline(runInput(), {
        activities: fake.activities,
        waitForApproval: vi.fn(async () => "approved" as const),
      }),
    ).rejects.toThrow("budget still exceeded after approval");

    expect(fake.fail).toHaveBeenCalledTimes(1);
    expect(fake.finish).not.toHaveBeenCalled();
  });
});
