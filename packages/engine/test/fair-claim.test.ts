import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PriorityClass } from "@kit/core";
import { initStore, loadStoreConfig } from "@kit/store";
import type { PackRunInput } from "@kit/workflow";
import { describe, expect, it } from "vitest";
import { FairClaimScheduler } from "../src/fair-claim";
import { enqueueLocalRun } from "../src/local-runner";

async function withStore<T>(
  run: (store: Awaited<ReturnType<typeof initStore>>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-fair-claim-"));
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: dir,
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
  try {
    return await run(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

let clock = 0;

function createdAt(): string {
  clock += 1000;
  return new Date(Date.UTC(2026, 0, 1) + clock).toISOString();
}

async function queue(
  store: Awaited<ReturnType<typeof initStore>>,
  input: {
    id: string;
    workspaceId: string;
    priority: PriorityClass;
    payload?: string;
  },
): Promise<void> {
  await store.runRequests.enqueue({
    requestId: `rrq_${input.id}`,
    runId: `run_${input.id}`,
    workspaceId: input.workspaceId,
    workflowId: "demo",
    kind: "pack_run",
    payload: input.payload ?? "{}",
    priority: input.priority,
    createdAt: createdAt(),
    updatedAt: createdAt(),
  });
}

function packRun(
  runId: string,
  runMode: PackRunInput["runMode"] = "DRY_RUN",
): PackRunInput {
  return {
    runId,
    eventId: `evt_${runId}`,
    workspaceId: "default",
    workflowId: "demo",
    workflowVersion: "1.0",
    runMode,
    initialInput: "hello",
    stages: [],
    stub: true,
  };
}

const NOON = new Date(Date.UTC(2026, 0, 2));

describe("FairClaimScheduler", () => {
  it("interleaves a workspace burst so it cannot starve other workspaces", async () => {
    await withStore(async (store) => {
      for (let i = 0; i < 60; i += 1) {
        await queue(store, {
          id: `alpha-${i}`,
          workspaceId: "alpha",
          priority: "P2",
        });
      }
      for (let i = 0; i < 4; i += 1) {
        await queue(store, {
          id: `beta-${i}`,
          workspaceId: "beta",
          priority: "P2",
        });
      }

      const scheduler = new FairClaimScheduler();
      const claimed: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        const next = await scheduler.claimNext(store, "worker", NOON, 60_000);
        if (!next) {
          break;
        }
        claimed.push(next.workspaceId);
      }

      // Beta's burst is served early despite alpha's 60-row backlog.
      expect(
        claimed.filter((id) => id === "beta").length,
      ).toBeGreaterThanOrEqual(2);
      expect(claimed.slice(0, 4)).toContain("beta");
      expect(claimed[0]).toBe("alpha");
    });
  });

  it("serves P0 ahead of queued work even across workspaces", async () => {
    await withStore(async (store) => {
      await queue(store, {
        id: "alpha-first",
        workspaceId: "alpha",
        priority: "P2",
      });
      await queue(store, {
        id: "beta-next",
        workspaceId: "beta",
        priority: "P2",
      });
      await queue(store, {
        id: "alpha-urgent",
        workspaceId: "alpha",
        priority: "P0",
      });

      const scheduler = new FairClaimScheduler();
      const next = await scheduler.claimNext(store, "worker", NOON, 60_000);
      expect(next?.requestId).toBe("rrq_alpha-urgent");
      expect(next?.priority).toBe("P0");
    });
  });

  it("reclaims a stale claim through the fair path with its stored priority", async () => {
    await withStore(async (store) => {
      await queue(store, {
        id: "stale",
        workspaceId: "alpha",
        priority: "P1",
      });
      const first = await store.runRequests.claimNext("worker-a", NOON, 60_000);
      expect(first?.status).toBe("claimed");

      const scheduler = new FairClaimScheduler();
      const tooSoon = await scheduler.claimNext(
        store,
        "worker-b",
        NOON,
        60_000,
      );
      expect(tooSoon).toBeNull();

      const later = new Date(NOON.getTime() + 120_000);
      const reclaimed = await scheduler.claimNext(
        store,
        "worker-b",
        later,
        60_000,
      );
      expect(reclaimed?.requestId).toBe("rrq_stale");
      expect(reclaimed?.claimedBy).toBe("worker-b");
      expect(reclaimed?.priority).toBe("P1");
    });
  });
});

describe("admission gate on enqueue", () => {
  it("drops P3 when the queue is full while P2 waits", async () => {
    await withStore(async (store) => {
      const policy = { admissionPolicy: { maxQueueDepth: 1 } };
      const first = await enqueueLocalRun(packRun("drop-1"), store, policy);
      expect(first.dropped).toBe(false);
      expect(first.admission).toBe("queue");

      const second = await enqueueLocalRun(packRun("drop-2"), store, policy);
      expect(second.priority).toBe("P3");
      expect(second.dropped).toBe(true);
      expect(second.admission).toBe("drop");
      const dropped = await store.runRequests.find("drop-2");
      expect(dropped?.status).toBe("dropped");
      expect(dropped?.admissionReason).toContain("P3 dropped");

      // Normal business traffic (LIVE = P2) is still queued under pressure.
      const live = await enqueueLocalRun(
        packRun("live-1", "LIVE"),
        store,
        policy,
      );
      expect(live.priority).toBe("P2");
      expect(live.dropped).toBe(false);
      expect(live.admission).toBe("queue");
      expect((await store.runRequests.find("live-1"))?.status).toBe("queued");
    });
  });

  it("merges duplicate requests instead of queueing twice", async () => {
    await withStore(async (store) => {
      const first = await enqueueLocalRun(packRun("dupe"), store);
      const second = await enqueueLocalRun(packRun("dupe"), store);
      expect(second.requestId).toBe(first.requestId);
      expect(second.admission).toBe("merge");
      expect(second.dropped).toBe(false);
      expect(await store.runRequests.countQueued()).toBe(1);
    });
  });
});

describe("legacy FIFO compatibility", () => {
  it("claims pre-60.6 rows in created_at order and recovers priority from payload", async () => {
    await withStore(async (store) => {
      const now = createdAt();
      // Simulates rows written before the priority column existed.
      await store.sql`
        INSERT INTO run_requests (
          request_id, run_id, workspace_id, workflow_id, kind, payload, status,
          created_at, updated_at
        ) VALUES (
          'rrq_legacy_1', 'run_legacy_1', 'alpha', 'demo', 'pack_run',
          '{"priority":"P1"}', 'queued', ${now}, ${now}
        )
      `;
      await store.sql`
        INSERT INTO run_requests (
          request_id, run_id, workspace_id, workflow_id, kind, payload, status,
          created_at, updated_at
        ) VALUES (
          'rrq_legacy_2', 'run_legacy_2', 'alpha', 'demo', 'pack_run',
          '{}', 'queued', ${createdAt()}, ${createdAt()}
        )
      `;

      const first = await store.runRequests.claimNext(
        "legacy-worker",
        NOON,
        60_000,
      );
      expect(first?.requestId).toBe("rrq_legacy_1");
      expect(first?.priority).toBe("P1");
      expect(first?.admissionReason).toBeNull();

      const second = await store.runRequests.claimNext(
        "legacy-worker",
        NOON,
        60_000,
      );
      expect(second?.requestId).toBe("rrq_legacy_2");
      // No stored or payload priority: normal business default.
      expect(second?.priority).toBe("P2");
    });
  });
});
