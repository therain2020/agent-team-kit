import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { KillSwitch } from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import { initStore } from "../src/store";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-kill-switch-"));
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

const at = "2026-11-15T00:00:00.000Z";

function killSwitch(overrides: Partial<KillSwitch> = {}): KillSwitch {
  return {
    switchId: "kill_1",
    scope: "global",
    target: "",
    workspaceId: null,
    state: "active",
    activatedBy: "operator",
    reason: "drill",
    activatedAt: at,
    releasedBy: null,
    releasedAt: null,
    releaseReason: null,
    version: 1,
    updatedAt: at,
    ...overrides,
  };
}

describe("sqlite kill switch store", () => {
  it("activates idempotently and releases once", async () => {
    const store = await localStore();
    const first = await store.killSwitches.activate(killSwitch());
    expect(first.changed).toBe(true);
    expect(first.record.state).toBe("active");

    const again = await store.killSwitches.activate(
      killSwitch({ activatedAt: "2026-11-15T00:01:00.000Z" }),
    );
    expect(again.changed).toBe(false);
    expect(again.record.version).toBe(1);
    expect(again.record.activatedAt).toBe(at);
    expect(await store.killSwitches.listActive()).toHaveLength(1);

    const released = await store.killSwitches.release(
      "kill_1",
      "operator",
      "drill complete",
      "2026-11-15T00:02:00.000Z",
    );
    expect(released?.changed).toBe(true);
    expect(released?.record.state).toBe("released");
    expect(await store.killSwitches.listActive()).toHaveLength(0);

    const releaseAgain = await store.killSwitches.release(
      "kill_1",
      "operator",
      "drill complete",
      "2026-11-15T00:03:00.000Z",
    );
    expect(releaseAgain?.changed).toBe(false);
    expect(releaseAgain?.record.state).toBe("released");
  });

  it("reactivates a released switch with a new version", async () => {
    const store = await localStore();
    await store.killSwitches.activate(killSwitch());
    await store.killSwitches.release(
      "kill_1",
      "operator",
      "done",
      "2026-11-15T00:02:00.000Z",
    );

    const reactivated = await store.killSwitches.activate(
      killSwitch({
        reason: "second drill",
        activatedAt: "2026-11-15T00:04:00.000Z",
      }),
    );
    expect(reactivated.changed).toBe(true);
    expect(reactivated.record.state).toBe("active");
    expect(reactivated.record.version).toBe(3);
    expect(reactivated.record.reason).toBe("second drill");
    expect(reactivated.record.releasedAt).toBeNull();
  });

  it("keeps separate identities for scoped switches", async () => {
    const store = await localStore();
    await store.killSwitches.activate(killSwitch());
    await store.killSwitches.activate(
      killSwitch({
        switchId: "kill_2",
        scope: "workspace",
        target: "default",
        workspaceId: "default",
      }),
    );
    await store.killSwitches.activate(
      killSwitch({
        switchId: "kill_3",
        scope: "stage",
        target: "publish",
        workspaceId: "default",
      }),
    );

    const active = await store.killSwitches.listActive();
    expect(active).toHaveLength(3);
    expect(new Set(active.map((item) => item.scope))).toEqual(
      new Set(["global", "workspace", "stage"]),
    );
  });

  it("returns null when releasing an unknown switch", async () => {
    const store = await localStore();
    expect(
      await store.killSwitches.release("missing", "operator", "n/a", at),
    ).toBeNull();
  });
});
