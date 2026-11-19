import { type LastKnownGood, registerLastKnownGood } from "@kit/core";
import type {
  DegradationAuditRecord,
  DegradationStateRecord,
} from "@kit/store";
import { describe, expect, it, vi } from "vitest";
import {
  type DegradationGuardStore,
  LkgDeliveryBlockedError,
  createDegradationGuard,
  guardedActivities,
} from "../src/degradation-guard";
import type { PackPipelineActivities } from "../src/pack-pipeline";

const DAY_MS = 24 * 60 * 60 * 1000;

function mode(
  overrides: Partial<DegradationStateRecord> = {},
): DegradationStateRecord {
  return {
    scope: "workspace",
    workspaceId: "ws-1",
    modeId: "deg_1",
    kind: "degraded",
    triggers: [{ dependencyId: "model.provider", reason: "provider down" }],
    behavior: "serve the last-known-good",
    qualityFloor: { minChars: 20, forbiddenPatterns: ["TODO"] },
    exitCriteria: { minStableMinutes: 5, requireQualityRecheck: true },
    status: "active",
    enteredAt: new Date().toISOString(),
    enteredBy: "tester",
    exitedAt: null,
    exitReason: null,
    ...overrides,
  };
}

function pin(verifiedAt: string): LastKnownGood {
  return registerLastKnownGood({
    workspaceId: "ws-1",
    artifactRefs: [{ artifactId: "art_lkg", version: 1 }],
    verifier: "alice",
    verifiedAt,
    now: verifiedAt,
  });
}

function makeStore(input: {
  modes?: DegradationStateRecord[];
  lkg?: LastKnownGood[];
  text?: string | null;
}) {
  const audits: DegradationAuditRecord[] = [];
  const modes = input.modes ?? [mode()];
  const text = input.text ?? "A complete and cited answer with sources.";
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
    lkg: {
      listActive: async () => input.lkg ?? [],
    },
  } as unknown as DegradationGuardStore;
  return { store, audits };
}

function activities(deliver: ReturnType<typeof vi.fn>) {
  return {
    preparePackRun: vi.fn(),
    executePackStage: vi.fn(),
    requestApproval: vi.fn(),
    finishPackRun: vi.fn(),
    failPackRun: vi.fn(),
    setPackRunStatus: vi.fn(),
    deliverPackRun: deliver,
  } as unknown as PackPipelineActivities;
}

describe("LKG delivery integration", () => {
  it("switches external delivery to the verified LKG while degraded", async () => {
    const { store } = makeStore({
      lkg: [pin(new Date().toISOString())],
    });
    const deliver = vi.fn(async () => undefined);
    const guarded = guardedActivities(
      createDegradationGuard(store),
      activities(deliver),
    );

    await guarded.deliverPackRun({
      runId: "run_1",
      workspaceId: "ws-1",
      artifactId: "art_new",
      channel: "im",
      runMode: "DRY_RUN",
    });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "art_lkg" }),
    );
  });

  it("blocks external delivery when the LKG expired past 7 days", async () => {
    const { store, audits } = makeStore({
      lkg: [pin(new Date(Date.now() - 8 * DAY_MS).toISOString())],
    });
    const deliver = vi.fn(async () => undefined);
    const guard = createDegradationGuard(store);

    await expect(
      guard.resolveDelivery({
        runId: "run_1",
        workspaceId: "ws-1",
        artifactId: "art_new",
        channel: "webhook",
      }),
    ).rejects.toBeInstanceOf(LkgDeliveryBlockedError);

    expect(audits.at(-1)?.detail).toMatchObject({
      action: "deliver",
      channel: "webhook",
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("blocks external delivery when no LKG exists", async () => {
    const { store } = makeStore({});
    const guard = createDegradationGuard(store);

    await expect(
      guard.resolveDelivery({
        runId: "run_1",
        workspaceId: "ws-1",
        artifactId: "art_new",
        channel: "email",
      }),
    ).rejects.toBeInstanceOf(LkgDeliveryBlockedError);
  });

  it("keeps internal delivery on the current artifact", async () => {
    const { store } = makeStore({});
    const deliver = vi.fn(async () => undefined);
    const guarded = guardedActivities(
      createDegradationGuard(store),
      activities(deliver),
    );

    await guarded.deliverPackRun({
      runId: "run_1",
      workspaceId: "ws-1",
      artifactId: "art_new",
      channel: "local_file",
      runMode: "DRY_RUN",
    });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "art_new" }),
    );
  });
});
