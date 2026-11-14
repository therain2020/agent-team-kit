import type {
  PackRunInput,
  PackRunResult,
  PackStageExecutionInput,
  PackStageExecutionResult,
  PreparePackRunInput,
  RequestApprovalInput,
  RequestApprovalResult,
} from "@kit/workflow";

export type ApprovalOutcome = "approved" | "aborted" | "timeout";

export interface PackPipelineActivities {
  preparePackRun(input: PreparePackRunInput): Promise<void>;
  executePackStage(
    input: PackStageExecutionInput,
  ): Promise<PackStageExecutionResult>;
  requestApproval(input: RequestApprovalInput): Promise<RequestApprovalResult>;
  finishPackRun(input: { runId: string }): Promise<void>;
  failPackRun(input: { runId: string; reason: string }): Promise<void>;
  setPackRunStatus(input: {
    runId: string;
    status: "paused" | "running";
  }): Promise<void>;
  deliverPackRun(input: {
    runId: string;
    workspaceId: string;
    artifactId: string;
    channel: "im" | "email" | "local_file" | "webhook";
    runMode: "DRY_RUN" | "LIVE";
  }): Promise<void>;
}

export interface PackPipelineIo {
  activities: PackPipelineActivities;
  waitForApproval(
    requestId: string | undefined,
    timeoutMs: number,
  ): Promise<ApprovalOutcome>;
}

export async function runPackPipeline(
  input: PackRunInput,
  io: PackPipelineIo,
): Promise<PackRunResult> {
  const activity = io.activities;
  await activity.preparePackRun({
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

  const artifactIds: string[] = [];

  try {
    const outputs = new Map<string, { artifactId: string; text: string }>();

    const waitForApproval = async (
      requestId: string | undefined,
      timeoutMs: number,
    ): Promise<void> => {
      await activity.setPackRunStatus({
        runId: input.runId,
        status: "paused",
      });
      const outcome = await io.waitForApproval(requestId, timeoutMs);
      if (outcome === "timeout") {
        throw new Error("approval timeout");
      }
      if (outcome === "aborted") {
        throw new Error("approval aborted");
      }
      await activity.setPackRunStatus({
        runId: input.runId,
        status: "running",
      });
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
        const approval = await activity.requestApproval({
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

      let result = await activity.executePackStage({
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
        result = await activity.executePackStage({
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
        const approval = await activity.requestApproval({
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

    await activity.finishPackRun({ runId: input.runId });

    const finalArtifactId = artifactIds[artifactIds.length - 1];
    if (input.delivery && finalArtifactId) {
      await activity.deliverPackRun({
        runId: input.runId,
        workspaceId: input.workspaceId,
        artifactId: finalArtifactId,
        channel: input.delivery.channel,
        runMode: input.runMode,
      });
    }

    return { runId: input.runId, artifactIds };
  } catch (error) {
    await activity.failPackRun({
      runId: input.runId,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
