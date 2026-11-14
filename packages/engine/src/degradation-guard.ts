import {
  type DegradedMode,
  activeModeFor,
  evaluateQualityFloor,
  isExecutionBlocked,
  newId,
} from "@kit/core";
import type {
  ArtifactStore,
  BlobClient,
  BlobRepository,
  DegradationStateRecord,
  DegradationStore,
} from "@kit/store";
import type { PackPipelineActivities } from "./pack-pipeline";

export interface DegradationGuardStore {
  degradation: Pick<DegradationStore, "listActive" | "appendAudit">;
  artifactStore: Pick<ArtifactStore, "findById">;
  blobs: Pick<BlobRepository, "findById">;
  blobClient: Pick<BlobClient, "get">;
}

export class ExecutionBlockedError extends Error {
  constructor(
    readonly modeId: string,
    readonly kind: DegradedMode["kind"],
    message: string,
  ) {
    super(message);
    this.name = "ExecutionBlockedError";
  }
}

export class QualityFloorError extends Error {
  constructor(
    readonly modeId: string,
    readonly reasons: string[],
  ) {
    super(`quality floor not met: ${reasons.join("; ")}`);
    this.name = "QualityFloorError";
  }
}

export interface DegradationGuard {
  modeFor(workspaceId: string): Promise<DegradedMode | null>;
  assertCanPrepare(input: {
    runId: string;
    workspaceId: string;
    workflowId: string;
  }): Promise<void>;
  assertCanExecute(input: {
    runId: string;
    workspaceId: string;
    stageId: string;
    stageName: string;
    failureMode?: "fail_open" | "fail_closed";
  }): Promise<void>;
  assertCanDeliver(input: {
    runId: string;
    workspaceId: string;
    artifactId: string;
    channel: string;
  }): Promise<void>;
}

export function toDegradedMode(record: DegradationStateRecord): DegradedMode {
  return {
    ...record,
    exitedAt: record.exitedAt ?? undefined,
    exitReason: record.exitReason ?? undefined,
  };
}

export async function activeModeForWorkspace(
  store: Pick<DegradationGuardStore, "degradation">,
  workspaceId: string,
): Promise<DegradedMode | null> {
  const records = await store.degradation.listActive();
  return activeModeFor(records.map(toDegradedMode), workspaceId);
}

export async function auditBlockedExecution(
  store: Pick<DegradationGuardStore, "degradation">,
  mode: DegradedMode,
  workspaceId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await store.degradation.appendAudit({
      auditId: newId("daud"),
      occurredAt: new Date().toISOString(),
      actor: "degradation-guard",
      action: "blocked",
      scope: mode.scope,
      workspaceId:
        mode.scope === "global" ? workspaceId : (mode.workspaceId as string),
      modeId: mode.modeId,
      detail,
    });
  } catch (error) {
    // The audit is evidence, not a precondition: never unblock on audit failure.
    console.error(
      `[degradation] audit failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Enforces degradation at the activity boundary so that both local and
 * Temporal execution paths share one choke point (61 §3.2, §5).
 */
export function createDegradationGuard(
  store: DegradationGuardStore,
): DegradationGuard {
  async function blockedMode(
    workspaceId: string,
  ): Promise<DegradedMode | null> {
    const mode = await activeModeForWorkspace(store, workspaceId);
    return isExecutionBlocked(mode) ? mode : null;
  }

  return {
    modeFor: (workspaceId) => activeModeForWorkspace(store, workspaceId),

    async assertCanPrepare(input) {
      const mode = await blockedMode(input.workspaceId);
      if (!mode) {
        return;
      }
      await auditBlockedExecution(store, mode, input.workspaceId, {
        action: "prepare",
        runId: input.runId,
        workflowId: input.workflowId,
      });
      throw new ExecutionBlockedError(
        mode.modeId,
        mode.kind,
        "new executions are paused by read-only mode",
      );
    },

    async assertCanExecute(input) {
      const readOnlyMode = await blockedMode(input.workspaceId);
      if (readOnlyMode) {
        await auditBlockedExecution(store, readOnlyMode, input.workspaceId, {
          action: "execute",
          runId: input.runId,
          stageId: input.stageId,
          stageName: input.stageName,
        });
        throw new ExecutionBlockedError(
          readOnlyMode.modeId,
          readOnlyMode.kind,
          "stage execution is paused by read-only mode",
        );
      }

      const mode = await activeModeForWorkspace(store, input.workspaceId);
      if (!mode || input.failureMode !== "fail_closed") {
        return;
      }
      await auditBlockedExecution(store, mode, input.workspaceId, {
        action: "execute",
        runId: input.runId,
        stageId: input.stageId,
        stageName: input.stageName,
        failureMode: "fail_closed",
      });
      throw new ExecutionBlockedError(
        mode.modeId,
        mode.kind,
        `stage ${input.stageName} is fail-closed during degraded mode`,
      );
    },

    async assertCanDeliver(input) {
      const mode = await activeModeForWorkspace(store, input.workspaceId);
      if (!mode) {
        return;
      }
      if (isExecutionBlocked(mode)) {
        await auditBlockedExecution(store, mode, input.workspaceId, {
          action: "deliver",
          runId: input.runId,
          artifactId: input.artifactId,
        });
        throw new ExecutionBlockedError(
          mode.modeId,
          mode.kind,
          "delivery is paused by read-only mode",
        );
      }

      const text = await readArtifactText(store, input.artifactId);
      if (text === null) {
        await auditBlockedExecution(store, mode, input.workspaceId, {
          action: "deliver",
          runId: input.runId,
          artifactId: input.artifactId,
          reason: "artifact unavailable",
        });
        throw new QualityFloorError(mode.modeId, ["artifact unavailable"]);
      }

      const floor = evaluateQualityFloor(text, mode.qualityFloor);
      if (!floor.pass) {
        await auditBlockedExecution(store, mode, input.workspaceId, {
          action: "deliver",
          runId: input.runId,
          artifactId: input.artifactId,
          reasons: floor.reasons,
        });
        throw new QualityFloorError(mode.modeId, floor.reasons);
      }
    },
  };
}

export function guardedActivities(
  guard: DegradationGuard,
  activities: PackPipelineActivities,
): PackPipelineActivities {
  return {
    ...activities,
    preparePackRun: async (input) => {
      await guard.assertCanPrepare({
        runId: input.runId,
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
      });
      return activities.preparePackRun(input);
    },
    executePackStage: async (input) => {
      await guard.assertCanExecute({
        runId: input.runId,
        workspaceId: input.workspaceId,
        stageId: input.stageId,
        stageName: input.stageName,
        failureMode: input.failureMode,
      });
      return activities.executePackStage(input);
    },
    deliverPackRun: async (input) => {
      await guard.assertCanDeliver({
        runId: input.runId,
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        channel: input.channel,
      });
      return activities.deliverPackRun(input);
    },
  };
}

async function readArtifactText(
  store: DegradationGuardStore,
  artifactId: string,
): Promise<string | null> {
  const artifact = await store.artifactStore.findById(artifactId);
  if (!artifact) {
    return null;
  }
  const blob = await store.blobs.findById(artifact.blobId);
  if (!blob) {
    return null;
  }
  try {
    const bytes = await store.blobClient.get(blob.storageKey);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
