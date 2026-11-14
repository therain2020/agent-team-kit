import { runPackPipeline } from "@kit/engine/pack-pipeline";
import type {
  IterationInput,
  IterationResult,
  IterationTaskResult,
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

async function runIterationWorkflow(
  input: IterationInput,
): Promise<IterationResult> {
  const planned = await iteration.planIteration(input);
  const results: IterationTaskResult[] = [];

  for (const task of planned.plan.tasks.slice(0, input.maxTasks)) {
    let coderResult:
      | Awaited<ReturnType<typeof iteration.runIterationCoder>>
      | undefined;
    let verification:
      | Awaited<ReturnType<typeof iteration.verifyIterationTask>>
      | undefined;
    let feedback = "";
    let error: string | undefined;

    for (let attempt = 0; attempt <= input.maxRepair; attempt += 1) {
      try {
        coderResult = await iteration.runIterationCoder({
          iterationId: input.iterationId,
          workspaceId: input.workspaceId,
          packDir: input.packDir,
          ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
          task,
          attempt,
          feedback,
          runMode: input.runMode,
          ...(input.coder ? { coderOverride: input.coder } : {}),
        });
        verification = await iteration.verifyIterationTask({
          iterationId: input.iterationId,
          workspaceId: input.workspaceId,
          packDir: input.packDir,
          task,
          sandboxDir: coderResult.sandboxDir,
          coderOk: coderResult.ok,
          coderSummary: coderResult.summary,
          changedFiles: coderResult.changedFiles,
        });
      } catch {
        error = "activity failed";
        break;
      }
      if (verification.pass) {
        break;
      }
      feedback = verification.feedback;
    }

    let risk: Awaited<ReturnType<typeof iteration.classifyIterationTask>> = {
      taskId: task.id,
      risk: task.risk,
      reasons: [],
      forbidden: false,
    };
    if (coderResult) {
      try {
        risk = await iteration.classifyIterationTask({
          iterationId: input.iterationId,
          workspaceId: input.workspaceId,
          packDir: input.packDir,
          task,
          changedFiles: coderResult.changedFiles,
          plannedRisk: task.risk,
        });
      } catch {
        error = error ?? "risk classification failed";
      }
    }

    let applied = false;
    let applyStatus: IterationTaskResult["applyStatus"];
    let applyReason: string | undefined;
    let commit: string | undefined;
    if (coderResult && verification?.pass) {
      try {
        const result = await apply.applyIterationTask({
          iterationId: input.iterationId,
          workspaceId: input.workspaceId,
          ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
          task,
          risk: risk.risk,
          forbidden: risk.forbidden,
          verificationPass: true,
          applyMode: input.applyMode,
          runMode: input.runMode,
          diffArtifactId: coderResult.diffArtifactId,
          baselineSha: coderResult.baselineSha,
          changedFiles: coderResult.changedFiles,
        });
        applied = result.applied;
        applyStatus = result.status;
        applyReason = result.reason;
        commit = result.commit;
      } catch {
        error = error ?? "apply failed";
      }
    }

    if (coderResult) {
      try {
        await iteration.cleanupIterationTask({
          sandboxDir: coderResult.sandboxDir,
        });
      } catch {
        // cleanup is best-effort
      }
    }

    const coder: IterationTaskResult["coder"] =
      coderResult?.coder ?? input.coder ?? "dsh";
    results.push({
      taskId: task.id,
      domain: task.domain,
      coder,
      coderOk: coderResult?.ok ?? false,
      verificationPass: verification?.pass ?? false,
      risk: risk.risk,
      applied,
      reasons: risk.reasons,
      ...(error ? { error } : {}),
      changedFiles: coderResult?.changedFiles ?? [],
      tokens: coderResult?.tokens ?? 0,
      ...(coderResult?.baselineSha
        ? { baselineSha: coderResult.baselineSha }
        : {}),
      ...(coderResult?.summary ? { coderSummary: coderResult.summary } : {}),
      ...(applyStatus ? { applyStatus } : {}),
      ...(applyReason ? { applyReason } : {}),
      ...(commit ? { commit } : {}),
    });
  }

  const report = await iteration.reportIteration({
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    goal: input.goal,
    plan: planned.plan,
    planArtifactId: planned.artifactId,
    tasks: results,
  });

  return {
    iterationId: input.iterationId,
    planArtifactId: planned.artifactId,
    tasks: results,
    ...report,
  };
}

export async function iterationWorkflow(
  input: IterationInput,
): Promise<IterationResult> {
  try {
    return await runIterationWorkflow(input);
  } catch (error) {
    await iteration.failIterationActivity({
      iterationId: input.iterationId,
      workspaceId: input.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
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
