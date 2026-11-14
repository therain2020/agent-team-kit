import type { PackRunInput, PackRunResult } from "@kit/workflow";
import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities";
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
} = proxyActivities<typeof packActivities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 2 },
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

  let current = input.initialInput;
  let lastArtifactId: string | undefined;
  let previousStageId: string | undefined;
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

    for (const stage of input.stages) {
      const upstream = stage.inputFromStageId
        ? outputs.get(stage.inputFromStageId)
        : undefined;

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
        inputText: upstream?.text ?? current,
        inputArtifactId: upstream?.artifactId ?? lastArtifactId,
        evidenceText: input.initialInput,
        stub: input.stub,
      });

      if (result.approvalRequired) {
        await waitForApproval(
          result.approvalRequestId,
          stage.approval?.ttlMs ?? 7 * 24 * 60 * 60 * 1000,
        );
        result = await executePackStage({
          ...stage,
          runId: input.runId,
          workspaceId: input.workspaceId,
          runMode: input.runMode,
          inputText: result.effectiveInputText ?? current,
          inputArtifactId: result.effectiveInputArtifactId ?? lastArtifactId,
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

      if (result.effectiveInputArtifactId && previousStageId) {
        outputs.set(previousStageId, {
          artifactId: result.effectiveInputArtifactId,
          text:
            result.effectiveInputText ??
            outputs.get(previousStageId)?.text ??
            "",
        });
      }

      outputs.set(stage.stageId, {
        artifactId: result.artifactId,
        text: result.text,
      });
      artifactIds.push(result.artifactId);
      current = result.text;
      lastArtifactId = result.artifactId;
      previousStageId = stage.stageId;
    }

    await finishPackRun({ runId: input.runId });

    return { runId: input.runId, artifactIds };
  } catch (error) {
    await failPackRun({
      runId: input.runId,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
