import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KillSwitchTrippedError } from "@kit/core";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateKillSwitch,
  assertKillSwitchClear,
  releaseKillSwitch,
} from "../src/kill-switch";
import { runPackPipeline } from "../src/pack-pipeline";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function localStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-kill-engine-"));
  dirs.push(dir);
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: dir,
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
  closers.push(() => store.close());
  return store;
}

async function auditKinds(store: Awaited<ReturnType<typeof localStore>>) {
  const rows = await store.sql<Array<{ kind: string }>>`
    SELECT kind FROM activity_events ORDER BY event_id ASC
  `;
  return rows.map((row) => row.kind);
}

describe("engine kill switch checkpoints", () => {
  it("blocks run, stage, model, and tool checkpoints and audits the trip", async () => {
    const store = await localStore();
    await activateKillSwitch(store, {
      scope: "global",
      reason: "drill",
      actor: "operator",
      role: "operator",
    });

    for (const checkpoint of ["run", "stage", "model", "tool"] as const) {
      await expect(
        assertKillSwitchClear(store, { workspaceId: "default" }, checkpoint),
      ).rejects.toBeInstanceOf(KillSwitchTrippedError);
    }

    const kinds = await auditKinds(store);
    expect(
      kinds.filter((kind) => kind === "kill_switch.activated"),
    ).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "kill_switch.tripped")).toHaveLength(
      4,
    );
  });

  it("scopes workspace, agent-source, and stage switches", async () => {
    const store = await localStore();
    await activateKillSwitch(store, {
      scope: "workspace",
      workspaceId: "alpha",
      reason: "workspace drill",
      actor: "operator",
      role: "operator",
    });
    await activateKillSwitch(store, {
      scope: "agent-source",
      target: "writer",
      reason: "bad source",
      actor: "security-bot",
      role: "security",
    });
    await activateKillSwitch(store, {
      scope: "stage",
      target: "publish",
      workspaceId: "alpha",
      reason: "publish hold",
      actor: "agent",
      role: "agent",
    });

    await expect(
      assertKillSwitchClear(store, { workspaceId: "alpha" }, "run"),
    ).rejects.toBeInstanceOf(KillSwitchTrippedError);
    await expect(
      assertKillSwitchClear(store, { workspaceId: "beta" }, "run"),
    ).resolves.toBeUndefined();
    await expect(
      assertKillSwitchClear(
        store,
        { workspaceId: "beta", agentId: "writer" },
        "model",
      ),
    ).rejects.toBeInstanceOf(KillSwitchTrippedError);
    await expect(
      assertKillSwitchClear(
        store,
        { workspaceId: "beta", agentId: "reviewer" },
        "model",
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertKillSwitchClear(
        store,
        { workspaceId: "alpha", stageName: "publish" },
        "stage",
      ),
    ).rejects.toBeInstanceOf(KillSwitchTrippedError);
    await expect(
      assertKillSwitchClear(
        store,
        { workspaceId: "beta", stageName: "publish" },
        "stage",
      ),
    ).resolves.toBeUndefined();
  });

  it("is idempotent on activation and clears after release", async () => {
    const store = await localStore();
    const first = await activateKillSwitch(store, {
      scope: "global",
      reason: "drill",
      actor: "operator",
      role: "operator",
    });
    const second = await activateKillSwitch(store, {
      scope: "global",
      reason: "drill again",
      actor: "operator",
      role: "operator",
    });
    expect(second.switchId).toBe(first.switchId);
    expect(second.version).toBe(first.version);

    let kinds = await auditKinds(store);
    expect(
      kinds.filter((kind) => kind === "kill_switch.activated"),
    ).toHaveLength(1);

    await releaseKillSwitch(store, {
      switchId: first.switchId,
      reason: "drill complete",
      actor: "operator",
      role: "operator",
    });
    await expect(
      assertKillSwitchClear(store, { workspaceId: "default" }, "run"),
    ).resolves.toBeUndefined();

    kinds = await auditKinds(store);
    expect(
      kinds.filter((kind) => kind === "kill_switch.released"),
    ).toHaveLength(1);
  });

  it("pauses the run instead of failing it when a checkpoint trips", async () => {
    const paused: string[] = [];
    const failed: string[] = [];
    const events: string[] = [];
    const tripped = new KillSwitchTrippedError(
      {
        switchId: "kill_stage",
        scope: "stage",
        target: "publish",
        workspaceId: "default",
        state: "active",
        activatedBy: "operator",
        reason: "hold publish",
        activatedAt: "2026-11-15T00:00:00.000Z",
        releasedBy: null,
        releasedAt: null,
        releaseReason: null,
        version: 1,
        updatedAt: "2026-11-15T00:00:00.000Z",
      },
      "stage",
    );

    await expect(
      runPackPipeline(
        {
          runId: "run_kill",
          eventId: "evt_kill",
          workspaceId: "default",
          workflowId: "demo",
          workflowVersion: "1.0",
          runMode: "DRY_RUN",
          initialInput: "hello",
          stub: true,
          stages: [
            {
              stageId: "run_kill:publish",
              stageName: "publish",
              type: "agent",
              agentId: "writer",
              instructions: "Publish.",
            },
          ],
        },
        {
          activities: {
            preparePackRun: async () => {
              events.push("prepare");
            },
            executePackStage: async () => {
              throw tripped;
            },
            requestApproval: async () => {
              throw new Error("unexpected approval");
            },
            finishPackRun: async () => {
              events.push("finish");
            },
            failPackRun: async (input) => {
              failed.push(input.runId);
            },
            setPackRunStatus: async (input) => {
              paused.push(input.status);
            },
            deliverPackRun: async () => {
              throw new Error("unexpected delivery");
            },
          },
          waitForApproval: async () => "approved",
        },
      ),
    ).rejects.toBe(tripped);

    expect(failed).toEqual([]);
    expect(paused).toEqual(["paused"]);
    expect(events).toEqual(["prepare"]);
  });

  it("enforces activation permissions", async () => {
    const store = await localStore();
    await expect(
      activateKillSwitch(store, {
        scope: "global",
        reason: "drill",
        actor: "security-bot",
        role: "security",
      }),
    ).rejects.toThrow(/only the operator/);
    await expect(
      activateKillSwitch(store, {
        scope: "workspace",
        workspaceId: "default",
        reason: "drill",
        actor: "agent",
        role: "agent",
      }),
    ).rejects.toThrow(/operator or a security alert/);
    await expect(
      activateKillSwitch(store, {
        scope: "stage",
        target: "publish",
        reason: "auto hold",
        actor: "agent",
        role: "agent",
      }),
    ).resolves.toMatchObject({ scope: "stage", target: "publish" });
  });
});
