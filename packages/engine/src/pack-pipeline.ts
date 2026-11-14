import { isKillSwitchTrippedError } from "@kit/core/kill-switch";
import type {
  PackRunInput,
  PackRunResult,
  PackStageExecutionInput,
  PackStageExecutionResult,
  PackStageSpec,
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

const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENCY_LIMIT = 16;
const BUDGET_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

interface SettledStage {
  index: number;
  ok: boolean;
  error?: unknown;
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
      ...(stage.agentId ? { agentId: stage.agentId } : {}),
    })),
    ...(input.budget ? { budget: input.budget } : {}),
  });

  const stageIndexById = new Map<string, number>();
  input.stages.forEach((stage, index) => {
    stageIndexById.set(stage.stageId, index);
  });

  const dependencyIds = input.stages.map((stage, index) =>
    resolveDependencies(stage, input.stages[index - 1]),
  );
  const gatingDependencies = dependencyIds.map((ids) =>
    ids
      .map((id) => stageIndexById.get(id))
      .filter((index): index is number => index !== undefined),
  );

  const outputs = new Map<string, { artifactId: string; text: string }>();
  const artifactSlots: Array<string | undefined> = new Array(
    input.stages.length,
  ).fill(undefined);
  const completed = new Set<number>();
  const pending = new Set<number>(input.stages.map((_, index) => index));
  const running = new Map<number, Promise<SettledStage>>();
  const maxConcurrency = resolveMaxConcurrency(input.maxConcurrency);

  let waitingApprovals = 0;
  let failure: { error: unknown } | undefined;

  const waitForApproval = async (
    requestId: string | undefined,
    timeoutMs: number,
  ): Promise<void> => {
    waitingApprovals += 1;
    await activity.setPackRunStatus({
      runId: input.runId,
      status: "paused",
    });
    try {
      const outcome = await io.waitForApproval(requestId, timeoutMs);
      if (outcome === "timeout") {
        throw new Error("approval timeout");
      }
      if (outcome === "aborted") {
        throw new Error("approval aborted");
      }
    } finally {
      waitingApprovals -= 1;
      if (waitingApprovals === 0) {
        await activity
          .setPackRunStatus({ runId: input.runId, status: "running" })
          .catch(() => undefined);
      }
    }
  };

  let budgetApprovalTail: Promise<void> = Promise.resolve();
  const acquireBudgetApproval = async (): Promise<() => void> => {
    let release = (): void => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = budgetApprovalTail;
    budgetApprovalTail = previous.then(() => next);
    await previous;
    return release;
  };

  const executeStageWithBudget = async (
    stageInput: PackStageExecutionInput,
  ): Promise<PackStageExecutionResult> => {
    let result = await activity.executePackStage(stageInput);
    if (!result.budgetPaused) {
      return result;
    }

    // Serialize budget exceptions so parallel DAG branches do not create
    // competing approval requests that the inbox cannot resolve.
    const release = await acquireBudgetApproval();
    try {
      result = await activity.executePackStage(stageInput);
      if (!result.budgetPaused) {
        return result;
      }
      const approval = await activity.requestApproval({
        runId: input.runId,
        workspaceId: input.workspaceId,
        runMode: input.runMode,
        stageId: stageInput.stageId,
        stageName: stageInput.stageName,
        requestType: "budget_exceeded",
        approval: {
          mode: "required",
          position: "after",
          riskClass: "high",
          ttlMs: BUDGET_APPROVAL_TTL_MS,
        },
        summary: `${result.budgetSummary ?? "budget exceeded"}\n\nIncrease the budget at /budgets, then approve to continue this stage.`,
        options: ["approve", "abort"],
      });
      if (approval.required) {
        await waitForApproval(approval.requestId, BUDGET_APPROVAL_TTL_MS);
      }
      result = await activity.executePackStage(stageInput);
      if (result.budgetPaused) {
        throw new Error("budget still exceeded after approval");
      }
      return result;
    } finally {
      release();
    }
  };

  const executeStage = async (index: number): Promise<void> => {
    const stage = input.stages[index];
    if (!stage) {
      return;
    }

    const dependencies = dependencyIds[index] ?? [];
    const upstreamArtifacts = dependencies
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

    let result = await executeStageWithBudget({
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
      result = await executeStageWithBudget({
        ...stage,
        runId: input.runId,
        workspaceId: input.workspaceId,
        runMode: input.runMode,
        inputText: result.effectiveInputText ?? inputText,
        inputArtifactId: result.effectiveInputArtifactId ?? inputArtifactIds[0],
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

    const draftSourceId = dependencies[0];
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
    artifactSlots[index] = result.artifactId;
  };

  try {
    while (pending.size > 0 || running.size > 0) {
      if (!failure) {
        for (let index = 0; index < input.stages.length; index += 1) {
          if (running.size >= maxConcurrency) {
            break;
          }
          if (!pending.has(index)) {
            continue;
          }
          const dependencies = gatingDependencies[index] ?? [];
          if (!dependencies.every((dependency) => completed.has(dependency))) {
            continue;
          }
          pending.delete(index);
          const promise = executeStage(index).then(
            (): SettledStage => ({ index, ok: true }),
            (error: unknown): SettledStage => ({ index, ok: false, error }),
          );
          running.set(index, promise);
        }
      }

      if (running.size === 0) {
        if (failure) {
          break;
        }
        throw new Error(
          "workflow has stages whose dependencies can never complete",
        );
      }

      const settled = await Promise.race(running.values());
      running.delete(settled.index);
      if (settled.ok) {
        completed.add(settled.index);
      } else {
        failure ??= { error: settled.error };
      }
    }

    if (failure) {
      throw failure.error;
    }

    await activity.finishPackRun({ runId: input.runId });

    const artifactIds = artifactSlots.filter(
      (artifactId): artifactId is string => typeof artifactId === "string",
    );
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
    if (isKillSwitchTrippedError(error)) {
      await activity.setPackRunStatus({
        runId: input.runId,
        status: "paused",
      });
    } else {
      await activity.failPackRun({
        runId: input.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

function resolveDependencies(
  stage: PackStageSpec,
  previous: PackStageSpec | undefined,
): string[] {
  if (stage.inputsFromStageIds?.length) {
    return stage.inputsFromStageIds;
  }
  if (stage.inputFromStageId) {
    return [stage.inputFromStageId];
  }
  return previous ? [previous.stageId] : [];
}

function resolveMaxConcurrency(value: number | undefined): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : DEFAULT_MAX_CONCURRENCY;
  return Math.min(Math.max(parsed, 1), MAX_CONCURRENCY_LIMIT);
}
