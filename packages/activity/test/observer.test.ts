import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initStore, listOps, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  ObserverActionError,
  listObserverActions,
  recordObserverAction,
} from "../src/index";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function sqliteStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-observer-"));
  dirs.push(dir);
  const config = loadStoreConfig({
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: dir,
    KIT_BLOB_ROOT: path.join(dir, "blobs"),
  });
  const store = await initStore(config);
  closers.push(() => store.close());
  return store;
}

describe("observer interventions", () => {
  it("writes one audit row per intervention", async () => {
    const store = await sqliteStore();
    const action = await recordObserverAction(store, {
      actor: "operator:test",
      type: "pause",
      targetRef: "workspace:default",
      reason: "stop new work while I inspect the loop",
    });

    expect(action.type).toBe("pause");
    expect(action.actor).toBe("operator:test");

    const ops = await listOps(store, {
      entityKind: "observer_action",
      limit: 10,
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.opId).toBe(action.actionId);
    expect(ops[0]?.actor).toBe("operator:test");
    expect(ops[0]?.op).toBe("observer.pause");

    const listed = await listObserverActions(store, { limit: 10 });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.targetRef).toBe("workspace:default");
    expect(listed[0]?.reason).toContain("inspect");
  });

  it("rejects forbidden and malformed actions without an audit trail", async () => {
    const store = await sqliteStore();

    await expect(
      recordObserverAction(store, {
        actor: "operator:test",
        // @ts-expect-error unknown actions are forbidden at runtime too.
        type: "nuke",
        targetRef: "global",
        reason: "not a real action",
      }),
    ).rejects.toBeInstanceOf(ObserverActionError);

    await expect(
      recordObserverAction(store, {
        actor: "operator:test",
        type: "edit",
        targetRef: "recovery-kernel",
        reason: "try to edit the recovery kernel",
      }),
    ).rejects.toBeInstanceOf(ObserverActionError);

    await expect(
      recordObserverAction(store, {
        actor: "operator:test",
        type: "kill",
        targetRef: "global",
        reason: "   ",
      }),
    ).rejects.toBeInstanceOf(ObserverActionError);

    expect(await listObserverActions(store, { limit: 10 })).toHaveLength(0);
  });

  it("records the rollback reference it fell back to", async () => {
    const store = await sqliteStore();
    const action = await recordObserverAction(store, {
      actor: "operator:test",
      type: "rollback",
      targetRef: "workspace-artifacts",
      reason: "regression after promotion",
      reference: "lkg:lkg_2->lkg_7",
    });

    expect(action.reference).toBe("lkg:lkg_2->lkg_7");
    const listed = await listObserverActions(store, { limit: 1 });
    expect(listed[0]?.type).toBe("rollback");
    expect(listed[0]?.reference).toBe("lkg:lkg_2->lkg_7");
  });

  it("refuses a rollback without a reference", async () => {
    const store = await sqliteStore();
    await expect(
      recordObserverAction(store, {
        actor: "operator:test",
        type: "rollback",
        targetRef: "workspace-artifacts",
        reason: "no pin",
      }),
    ).rejects.toBeInstanceOf(ObserverActionError);
  });
});
