import type {
  ApplyTaskActivityInput,
  ClassifyTaskActivityInput,
  CleanupInput,
  FailIterationInput,
  IterationApplyResult,
  IterationCoderResult,
  IterationInput,
  IterationReportResult,
  IterationResult,
  IterationRiskResult,
  IterationTaskResult,
  IterationVerificationResult,
  PlannedIteration,
  ReportIterationInput,
  RunCoderActivityInput,
  VerifyTaskActivityInput,
} from "@kit/workflow";

export interface IterationPipelineActivities {
  planIteration(input: IterationInput): Promise<PlannedIteration>;
  runIterationCoder(
    input: RunCoderActivityInput,
  ): Promise<IterationCoderResult>;
  verifyIterationTask(
    input: VerifyTaskActivityInput,
  ): Promise<IterationVerificationResult>;
  classifyIterationTask(
    input: ClassifyTaskActivityInput,
  ): Promise<IterationRiskResult>;
  applyIterationTask(
    input: ApplyTaskActivityInput,
  ): Promise<IterationApplyResult>;
  cleanupIterationTask(input: CleanupInput): Promise<void>;
  reportIteration(input: ReportIterationInput): Promise<IterationReportResult>;
  failIterationActivity(input: FailIterationInput): Promise<void>;
  /** Optional cooperative cancellation probe; absent on engines without it. */
  isIterationCancelled?(iterationId: string): Promise<boolean>;
  /** Optional finalizer for a cancelled run; absent on engines without it. */
  cancelIteration?(input: {
    iterationId: string;
    workspaceId: string;
    reason: string;
  }): Promise<void>;
}

export class IterationCancelledError extends Error {
  constructor(message = "iteration cancelled by operator") {
    super(message);
    this.name = "IterationCancelledError";
  }
}

export async function runIterationPipeline(
  input: IterationInput,
  activities: IterationPipelineActivities,
): Promise<IterationResult> {
  try {
    return await executeIteration(input, activities);
  } catch (error) {
    if (error instanceof IterationCancelledError) {
      throw error;
    }
    await activities.failIterationActivity({
      iterationId: input.iterationId,
      workspaceId: input.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function executeIteration(
  input: IterationInput,
  activities: IterationPipelineActivities,
): Promise<IterationResult> {
  const checkCancelled = async (): Promise<void> => {
    if (!activities.isIterationCancelled) {
      return;
    }
    if (!(await activities.isIterationCancelled(input.iterationId))) {
      return;
    }
    const reason = "aborted by operator";
    await activities.cancelIteration?.({
      iterationId: input.iterationId,
      workspaceId: input.workspaceId,
      reason,
    });
    throw new IterationCancelledError(reason);
  };

  const planned = await activities.planIteration(input);
  await checkCancelled();
  const results: IterationTaskResult[] = [];

  for (const task of planned.plan.tasks.slice(0, input.maxTasks)) {
    await checkCancelled();

    let coderResult: IterationCoderResult | undefined;
    let verification: IterationVerificationResult | undefined;
    let feedback = "";
    let error: string | undefined;

    for (let attempt = 0; attempt <= input.maxRepair; attempt += 1) {
      try {
        coderResult = await activities.runIterationCoder({
          iterationId: input.iterationId,
          workspaceId: input.workspaceId,
          packDir: input.packDir,
          ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
          task,
          attempt,
          feedback,
          runMode: input.runMode,
          ...(input.coder ? { coderOverride: input.coder } : {}),
          ...(input.budget ? { budget: input.budget } : {}),
        });
        verification = await activities.verifyIterationTask({
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
      await checkCancelled();
    }

    await checkCancelled();

    let risk: IterationRiskResult = {
      taskId: task.id,
      risk: task.risk,
      reasons: [],
      forbidden: false,
    };
    if (coderResult) {
      try {
        risk = await activities.classifyIterationTask({
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
        const result = await activities.applyIterationTask({
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
        await activities.cleanupIterationTask({
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

  const report = await activities.reportIteration({
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
