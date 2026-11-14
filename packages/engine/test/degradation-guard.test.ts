import type {
  DegradationAuditRecord,
  DegradationStateRecord,
} from "@kit/store";
import { describe, expect, it, vi } from "vitest";
import {
  type DegradationGuardStore,
  ExecutionBlockedError,
  QualityFloorError,
  createDegradationGuard,
  guardedActivities,
} from "../src/degradation-guard";
import type { PackPipelineActivities } from "../src/pack-pipeline";

function mode(
  overrides: Partial<DegradationStateRecord> = {},
): DegradationStateRecord {
  return {
    scope: "workspace",
    workspaceId: "ws-1",
    modeId: "deg_1",
    kind: "degraded",
    triggers: [{ dependencyId: "model.provider", reason: "provider down" }],
    behavior: "pause affected stages",
    qualityFloor: { minChars: 20, forbiddenPatterns: ["TODO"] },
    exitCriteria: { minStableMinutes: 5, requireQualityRecheck: true },
    status: "active",
    enteredAt: "2026-11-15T00:00:00.000Z",
    enteredBy: "tester",
    exitedAt: null,
    exitReason: null,
    ...overrides,
  };
}

function makeStore(modes: DegradationStateRecord[], text: string | null) {
  const audits: DegradationAuditRecord[] = [];
  const store = {
    degradation: {
      listActive: async () => modes,
      appendAudit: async (record: DegradationAuditRecord) => {
        audits.push(record);
      },
    },
    artifactStore: {
      findById: async () => (text === null ? null : { blobId: "blob_1" }),
    },
    blobs: {
      findById: async () => (text === null ? null : { storageKey: "key_1" }),
    },
    blobClient: {
      get: async () => new TextEncoder().encode(text ?? ""),
    },
  } as unknown as DegradationGuardStore;
  return { store, audits };
}

describe("degradation guard", () => {
  it("blocks preparation in read-only mode and records the audit", async () => {
    const { store, audits } = makeStore(
      [mode({ kind: "read_only" })],
      "answer",
    );
    const guard = createDegradationGuard(store);

    await expect(
      guard.assertCanPrepare({
        runId: "run_1",
        workspaceId: "ws-1",
        workflowId: "demo",
      }),
    ).rejects.toBeInstanceOf(ExecutionBlockedError);

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "blocked",
      modeId: "deg_1",
      detail: { action: "prepare", runId: "run_1" },
    });
  });

  it("does not leak one workspace's mode into another", async () => {
    const { store } = makeStore([mode()], "answer");
    const guard = createDegradationGuard(store);

    await expect(
      guard.assertCanPrepare({
        runId: "run_2",
        workspaceId: "ws-2",
        workflowId: "demo",
      }),
    ).resolves.toBeUndefined();
  });

  it("lets degraded workspaces run but blocks delivery below the floor", async () => {
    const { store, audits } = makeStore([mode()], "TODO: unfinished answer");
    const guard = createDegradationGuard(store);

    await expect(
      guard.assertCanPrepare({
        runId: "run_1",
        workspaceId: "ws-1",
        workflowId: "demo",
      }),
    ).resolves.toBeUndefined();

    await expect(
      guard.assertCanDeliver({
        runId: "run_1",
        workspaceId: "ws-1",
        artifactId: "art_1",
        channel: "local_file",
      }),
    ).rejects.toBeInstanceOf(QualityFloorError);
    expect(audits.at(-1)?.detail).toMatchObject({
      action: "deliver",
      artifactId: "art_1",
    });
  });

  it("delivers outputs that clear the floor", async () => {
    const { store, audits } = makeStore(
      [mode()],
      "A complete and cited answer with sources.",
    );
    const guard = createDegradationGuard(store);

    await expect(
      guard.assertCanDeliver({
        runId: "run_1",
        workspaceId: "ws-1",
        artifactId: "art_1",
        channel: "local_file",
      }),
    ).resolves.toBeUndefined();
    expect(audits).toHaveLength(0);
  });

  it("fails closed when the artifact cannot be read", async () => {
    const { store } = makeStore([mode()], null);
    const guard = createDegradationGuard(store);

    await expect(
      guard.assertCanDeliver({
        runId: "run_1",
        workspaceId: "ws-1",
        artifactId: "art_missing",
        channel: "local_file",
      }),
    ).rejects.toBeInstanceOf(QualityFloorError);
  });

  it("stops fail-closed stages in degraded mode but runs fail-open ones", async () => {
    const { store } = makeStore([mode()], "answer");
    const guard = createDegradationGuard(store);

    await expect(
      guard.assertCanExecute({
        runId: "run_1",
        workspaceId: "ws-1",
        stageId: "run_1:deliver",
        stageName: "deliver",
        failureMode: "fail_closed",
      }),
    ).rejects.toBeInstanceOf(ExecutionBlockedError);

    await expect(
      guard.assertCanExecute({
        runId: "run_1",
        workspaceId: "ws-1",
        stageId: "run_1:draft",
        stageName: "draft",
        failureMode: "fail_open",
      }),
    ).resolves.toBeUndefined();
  });

  it("wraps activities so read-only blocks before execution", async () => {
    const { store } = makeStore([mode({ kind: "read_only" })], "answer");
    const preparePackRun = vi.fn(async () => undefined);
    const activities = {
      preparePackRun,
      executePackStage: vi.fn(),
      requestApproval: vi.fn(),
      finishPackRun: vi.fn(),
      failPackRun: vi.fn(),
      setPackRunStatus: vi.fn(),
      deliverPackRun: vi.fn(),
    } as unknown as PackPipelineActivities;

    const guarded = guardedActivities(
      createDegradationGuard(store),
      activities,
    );

    await expect(
      guarded.preparePackRun({
        runId: "run_1",
        eventId: "evt_1",
        workspaceId: "ws-1",
        workflowId: "demo",
        workflowVersion: "1.0",
        runMode: "DRY_RUN",
        stages: [],
      }),
    ).rejects.toBeInstanceOf(ExecutionBlockedError);
    expect(preparePackRun).not.toHaveBeenCalled();
  });
});
