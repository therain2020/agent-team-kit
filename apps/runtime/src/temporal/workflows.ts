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
  await preparePackRun({
    runId: input.runId,
    eventId: input.eventId,
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    runMode: input.runMode,
    stages: input.stages.map((stage) => ({
      stageId: stage.stageId,
      name: stage.stageName,
    })),
  });

  let approvalPayload:
    | { decision: "approve" | "abort"; note?: string; requestId?: string }
    | undefined;
  const artifactIds: string[] = [];

  setHandler(approvalSignal, (payload) => {
    approvalPayload = payload;
  });

  try {
    const outputs = new Map<string, { artifactId: string; text: string }>();

    const waitForApproval = async (
      requestId: string | undefined,
      timeoutMs: number,
    ): Promise<void> => {
      await setPackRunStatus({ runId: input.runId, status: "paused" });
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
        await failPackRun({
          runId: input.runId,
          reason: "approval timeout",
        });
        throw new Error("approval timeout");
      }

      if (payload.decision !== "approve") {
        await failPackRun({
          runId: input.runId,
          reason: `approval ${payload.decision}`,
        });
        throw new Error("approval aborted");
      }

      await setPackRunStatus({ runId: input.runId, status: "running" });
    };

    for (let index = 0; index < input.stages.length; index += 1) {
      const stage = input.stages[index];
      if (!stage) {
        continue;
      }

      const previousStage = input.stages[index - 1];
      const dependencyIds = stage.inputsFromStageIds?.length
        ? stage.inputsFromStageIds
        : stage.inputFromStageId
          ? [stage.inputFromStageId]
          : previousStage
            ? [previousStage.stageId]
            : [];

      const upstreamArtifacts = dependencyIds
        .map((dependencyId) => outputs.get(dependencyId))
        .filter(
          (value): value is { artifactId: string; text: string } =>
            value !== undefined,
        );

      const upstreamTexts = upstreamArtifacts
        .map((item) => item.text)
        .filter((text) => text.length > 0);

      const inputText =
        upstreamTexts.length === 0
          ? input.initialInput
          : upstreamTexts.length === 1
            ? (upstreamTexts[0] ?? input.initialInput)
            : upstreamTexts.join("\n\n---\n\n");
      const inputArtifactIds = upstreamArtifacts.map((item) => item.artifactId);

      if (
        stage.approval &&
        stage.approval.mode !== "never" &&
        stage.approval.position === "before"
      ) {
        const approval = await requestApproval({
          runId: input.runId,
          workspaceId: input.workspaceId,
          runMode: input.runMode,
          stageId: stage.stageId,
          stageName: stage.stageName,
          requestType: "stage_before",
          approval: stage.approval,
          summary: `Approve before running stage "${stage.stageName}".`,
          options: ["approve", "abort"],
        });
        if (approval.required) {
          await waitForApproval(approval.requestId, stage.approval.ttlMs);
        }
      }

      let result = await executePackStage({
        ...stage,
        runId: input.runId,
        workspaceId: input.workspaceId,
        runMode: input.runMode,
        inputText,
        inputArtifactId: inputArtifactIds[0],
        inputArtifactIds,
        evidenceText: input.initialInput,
        stub: input.stub,
      });

      if (result.approvalRequired) {
        await waitForApproval(
          result.approvalRequestId,
          stage.approval?.ttlMs ?? 7 * 24 * 60 * 60 * 1000,
        );
        const revisedArtifactIds =
          result.effectiveInputArtifactId && inputArtifactIds.length > 0
            ? [result.effectiveInputArtifactId, ...inputArtifactIds.slice(1)]
            : inputArtifactIds;
        result = await executePackStage({
          ...stage,
          runId: input.runId,
          workspaceId: input.workspaceId,
          runMode: input.runMode,
          inputText: result.effectiveInputText ?? inputText,
          inputArtifactId:
            result.effectiveInputArtifactId ?? inputArtifactIds[0],
          inputArtifactIds: revisedArtifactIds,
          evidenceText: input.initialInput,
          stub: input.stub,
          gateApproved: true,
        });
      }

      if (
        stage.approval &&
        stage.approval.mode !== "never" &&
        stage.approval.position === "after"
      ) {
        const approval = await requestApproval({
          runId: input.runId,
          workspaceId: input.workspaceId,
          runMode: input.runMode,
          stageId: stage.stageId,
          stageName: stage.stageName,
          requestType: "stage_after",
          approval: stage.approval,
          summary: `Approve the output of stage "${stage.stageName}".\n\n${result.text.slice(0, 400)}`,
          draftArtifactId: result.artifactId,
          options: ["approve", "abort"],
        });
        if (approval.required) {
          await waitForApproval(approval.requestId, stage.approval.ttlMs);
        }
      }

      const draftSourceId = dependencyIds[0];
      if (result.effectiveInputArtifactId && draftSourceId) {
        outputs.set(draftSourceId, {
          artifactId: result.effectiveInputArtifactId,
          text:
            result.effectiveInputText ?? outputs.get(draftSourceId)?.text ?? "",
        });
      }

      outputs.set(stage.stageId, {
        artifactId: result.artifactId,
        text: result.text,
      });
      artifactIds.push(result.artifactId);
    }

    await finishPackRun({ runId: input.runId });

    const finalArtifactId = artifactIds[artifactIds.length - 1];
    if (input.delivery && finalArtifactId) {
      await deliverPackRun({
        runId: input.runId,
        workspaceId: input.workspaceId,
        artifactId: finalArtifactId,
        channel: input.delivery.channel,
        runMode: input.runMode,
      });
    }

    return { runId: input.runId, artifactIds };
  } catch (error) {
    await failPackRun({
      runId: input.runId,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
