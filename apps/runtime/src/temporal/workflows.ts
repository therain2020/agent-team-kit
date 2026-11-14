import {
  type IterationPipelineActivities,
  runIterationPipeline,
} from "@kit/engine/iteration-pipeline";
import { runPackPipeline } from "@kit/engine/pack-pipeline";
import type {
  IterationInput,
  IterationResult,
  PackRunInput,
  PackRunResult,
} from "@kit/workflow";
import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type * as iterationActivities from "./iteration-activities";
import type * as packActivities from "./pack-activities";
import type { DemoInput, DemoResult } from "./types";

export const approvalSignal =
  defineSignal<
    [{ decision: "approve" | "abort"; note?: string; requestId?: string }]
  >("approval");

const { prepareRun, runStage, finishRun } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  heartbeatTimeout: "5 seconds",
  retry: { maximumAttempts: 5 },
});

const {
  preparePackRun,
  executePackStage,
  finishPackRun,
  failPackRun,
  setPackRunStatus,
  requestApproval,
  deliverPackRun,
} = proxyActivities<typeof packActivities>({
  startToCloseTimeout: "40 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 2 },
});

const iteration = proxyActivities<typeof iterationActivities>({
  startToCloseTimeout: "45 minutes",
  retry: { maximumAttempts: 1 },
});

const applyTaskQueue = "kit-apply";
const apply = proxyActivities<
  Pick<typeof iterationActivities, "applyIterationTask">
>({
  taskQueue: applyTaskQueue,
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

export async function demoWorkflow(input: DemoInput): Promise<DemoResult> {
  const prepared = await prepareRun(input);

  const first = await runStage({
    runId: input.runId,
    workspaceId: input.workspaceId,
    stageId: prepared.stage1Id,
    stageName: "stage-1",
  });

  const second = await runStage({
    runId: input.runId,
    workspaceId: input.workspaceId,
    stageId: prepared.stage2Id,
    stageName: "stage-2",
    inputArtifactId: first.artifactId,
    sleepMs: input.sleepMs,
  });

  await finishRun({ runId: input.runId });

  return {
    runId: input.runId,
    artifacts: [first.artifactId, second.artifactId],
  };
}

export async function iterationWorkflow(
  input: IterationInput,
): Promise<IterationResult> {
  const pipelineActivities: IterationPipelineActivities = {
    planIteration: iteration.planIteration,
    runIterationCoder: iteration.runIterationCoder,
    verifyIterationTask: iteration.verifyIterationTask,
    classifyIterationTask: iteration.classifyIterationTask,
    // Apply runs on its own single-concurrency queue to serialize repo writes.
    applyIterationTask: apply.applyIterationTask,
    cleanupIterationTask: iteration.cleanupIterationTask,
    reportIteration: iteration.reportIteration,
    failIterationActivity: iteration.failIterationActivity,
    isIterationCancelled: iteration.isIterationCancelled,
    cancelIteration: iteration.cancelIteration,
  };
  return runIterationPipeline(input, pipelineActivities);
}

export async function packWorkflow(
  input: PackRunInput,
): Promise<PackRunResult> {
  const approvalQueue: Array<{
    decision: "approve" | "abort";
    note?: string;
    requestId?: string;
  }> = [];

  setHandler(approvalSignal, (payload) => {
    approvalQueue.push(payload);
  });

  const matches = (
    payload: { requestId?: string },
    requestId: string | undefined,
  ) => !payload.requestId || !requestId || payload.requestId === requestId;

  return runPackPipeline(input, {
    activities: {
      preparePackRun,
      executePackStage,
      requestApproval,
      finishPackRun,
      failPackRun,
      setPackRunStatus,
      deliverPackRun,
    },
    waitForApproval: async (requestId, timeoutMs) => {
      const fulfilled = await condition(
        () => approvalQueue.some((payload) => matches(payload, requestId)),
        timeoutMs,
      );

      const index = approvalQueue.findIndex((payload) =>
        matches(payload, requestId),
      );
      if (!fulfilled || index < 0) {
        return "timeout";
      }
      const [payload] = approvalQueue.splice(index, 1);

      if (!payload) {
        return "timeout";
      }
      return payload.decision === "approve" ? "approved" : "aborted";
    },
  });
}
