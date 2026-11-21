import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DegradationContractError,
  enterDegradedMode,
  runbookCoverage,
} from "@kit/core";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DegradationDrillReport,
  runDegradationDrill,
  runDegradationDrills,
} from "./degradation-drill";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
const at = "2026-11-21T00:00:00.000Z";

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function localStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-degradation-drill-"));
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

function check(report: DegradationDrillReport, id: string) {
  return report.checks.find((item) => item.id === id);
}

describe("degradation drills", () => {
  it("runs the workspace drill independently and verifies recovery", async () => {
    const store = await localStore();
    const report = await runDegradationDrill(store, "workspace", {
      workspaceId: "ws-1",
      otherWorkspaceId: "ws-2",
      executedBy: "tester",
      now: at,
    });

    expect(report.ok).toBe(true);
    expect(report.modeId).not.toBeNull();
    expect(check(report, "workspace_isolation")?.ok).toBe(true);
    expect(check(report, "quality_floor_gate")?.ok).toBe(true);
    expect(check(report, "exit_requires_quality_recheck")?.ok).toBe(true);
    expect(check(report, "recovery_persisted")?.ok).toBe(true);
    expect(check(report, "drill_recorded")?.ok).toBe(true);

    const stored = await store.degradation.get("workspace", "ws-1");
    expect(stored?.status).toBe("exited");
    expect(await store.degradation.listActive()).toHaveLength(0);

    const drills = await store.drills.listRunbookDrillsByWorkspace("ws-1");
    expect(drills.map((item) => item.drillId)).toContain(report.drillId);

    const audits = await store.degradation.listAudit(50);
    const actions = audits
      .filter((audit) => audit.modeId === report.modeId)
      .map((audit) => audit.action)
      .sort();
    expect(actions).toEqual(["enter", "exit"]);

    const coverage = runbookCoverage(await store.runbooks.list("ws-1"), drills);
    expect(coverage.coveredModes).toContain("model.provider");
  });

  it("does not leak a workspace drill into a peer workspace", async () => {
    const store = await localStore();
    await runDegradationDrill(store, "workspace", {
      workspaceId: "ws-1",
      otherWorkspaceId: "ws-2",
      executedBy: "tester",
      now: at,
    });

    expect(await store.degradation.get("workspace", "ws-2")).toBeNull();
    expect(
      await store.drills.listRunbookDrillsByWorkspace("ws-2"),
    ).toHaveLength(0);
  });

  it("runs the global drill only through a security event", async () => {
    const store = await localStore();
    const report = await runDegradationDrill(store, "global", {
      workspaceId: "ws-1",
      executedBy: "tester",
      now: at,
    });

    expect(report.ok).toBe(true);
    expect(check(report, "global_requires_security_event")?.ok).toBe(true);
    expect(check(report, "global_governs_all")?.ok).toBe(true);
    expect(check(report, "global_read_only_blocks_execution")?.ok).toBe(true);
    expect(check(report, "recovery_persisted")?.ok).toBe(true);

    const stored = await store.degradation.get("global", "*");
    expect(stored?.status).toBe("exited");
    expect(stored?.workspaceId).toBe("*");

    const audits = await store.degradation.listAudit(50);
    const enter = audits.find(
      (audit) => audit.modeId === report.modeId && audit.action === "enter",
    );
    expect(enter?.detail.securityEvent).toBe(true);
    expect(await store.degradation.listActive()).toHaveLength(0);
  });

  it("rejects global entry without a security event at the core contract", () => {
    expect(() =>
      enterDegradedMode({
        scope: "global",
        kind: "degraded",
        triggers: [
          { dependencyId: "artifact_store", reason: "no security event" },
        ],
        behavior: "must be rejected",
        actor: "tester",
        now: at,
      }),
    ).toThrow(DegradationContractError);
  });

  it("refuses to overwrite a live active degradation", async () => {
    const store = await localStore();
    const live = enterDegradedMode({
      scope: "workspace",
      workspaceId: "ws-1",
      kind: "read_only",
      triggers: [{ dependencyId: "delivery", reason: "real incident" }],
      behavior: "live read-only",
      actor: "operator",
      now: at,
    });
    await store.degradation.upsert({
      ...live,
      exitedAt: null,
      exitReason: null,
    });

    const report = await runDegradationDrill(store, "workspace", {
      workspaceId: "ws-1",
      now: at,
    });
    expect(report.ok).toBe(false);
    expect(report.modeId).toBeNull();

    const stored = await store.degradation.get("workspace", "ws-1");
    expect(stored?.modeId).toBe(live.modeId);
    expect(stored?.status).toBe("active");
  });

  it("runs both scopes independently in one pass", async () => {
    const store = await localStore();
    const reports = await runDegradationDrills(store, "both", {
      workspaceId: "ws-1",
      otherWorkspaceId: "ws-2",
      executedBy: "tester",
      now: at,
    });

    expect(reports.map((report) => report.scope)).toEqual([
      "workspace",
      "global",
    ]);
    expect(reports.every((report) => report.ok)).toBe(true);
    expect(await store.degradation.listActive()).toHaveLength(0);

    const drills = await store.drills.listRunbookDrillsByWorkspace("ws-1");
    expect(drills).toHaveLength(2);
  });
});
