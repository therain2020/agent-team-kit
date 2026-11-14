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
    let applyReason: string | undefined;
    let commit: string | undefined;
    if (coderResult && verification?.pass) {
      try {
        const apply = await iteration.applyIterationTask({
          iterationId: input.iterationId,
          workspaceId: input.workspaceId,
          task,
          risk: risk.risk,
          forbidden: risk.forbidden,
          verificationPass: true,
          applyMode: input.applyMode,
          runMode: input.runMode,
          diffArtifactId: coderResult.diffArtifactId,
        });
        applied = apply.applied;
        applyReason = apply.reason;
        commit = apply.commit;
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
      ...(coderResult?.summary ? { coderSummary: coderResult.summary } : {}),
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

export async function packWorkflow(
  input: PackRunInput,
): Promise<PackRunResult> {
  let approvalPayload:
    | { decision: "approve" | "abort"; note?: string; requestId?: string }
    | undefined;

  setHandler(approvalSignal, (payload) => {
    approvalPayload = payload;
  });

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
        () =>
          approvalPayload !== undefined &&
          (!approvalPayload.requestId ||
            !requestId ||
            approvalPayload.requestId === requestId),
        timeoutMs,
      );

      const payload = approvalPayload;
      approvalPayload = undefined;

      if (!fulfilled || !payload) {
        return "timeout";
      }
      return payload.decision === "approve" ? "approved" : "aborted";
    },
  });
}
