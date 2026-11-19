import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendIncidentTimeline,
  newIncident,
  newRecoveryDrill,
  newRunbook,
  newRunbookDrill,
  runbookCoverage,
} from "@kit/core";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-incident-"));
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

describe("incident store", () => {
  it("round-trips incidents and enforces optimistic versioning", async () => {
    const store = await localStore();
    const record = newIncident({
      workspaceId: "ws-1",
      title: "event bus outage",
      severity: "sev1",
      owner: "alice",
      detectedAt: at,
      now: at,
    });
    await store.incidents.create(record);

    const fetched = await store.incidents.get(record.incidentId);
    expect(fetched?.title).toBe("event bus outage");
    expect(fetched?.timeline).toHaveLength(1);
    expect(fetched?.version).toBe(0);
    if (!fetched) {
      throw new Error("incident was not persisted");
    }

    const resolved = appendIncidentTimeline(fetched, {
      kind: "resolved",
      actor: "alice",
      note: "spool drained",
      at: "2026-11-15T03:00:00.000Z",
    });
    expect(await store.incidents.update(resolved)).toBe(true);
    expect(resolved.version).toBe(1);

    // The stale copy still carries version 0 and must be rejected.
    const stale = appendIncidentTimeline(fetched, {
      kind: "note",
      actor: "bob",
      note: "late note",
      at: "2026-11-15T04:00:00.000Z",
    });
    stale.version = 0;
    expect(await store.incidents.update(stale)).toBe(false);

    const listed = await store.incidents.list("ws-1", { status: "resolved" });
    expect(listed.map((item) => item.incidentId)).toEqual([record.incidentId]);
    expect(listed[0]?.postmortem.draftDueAt).toBe("2026-11-16T00:00:00.000Z");
  });
});

describe("runbook and drill store", () => {
  it("upserts runbooks, records drills, and reports coverage", async () => {
    const store = await localStore();
    const rb = newRunbook({
      workspaceId: "ws-1",
      modeId: "artifact_store",
      trigger: "artifact store unreachable",
      owner: "alice",
      steps: [
        { order: 1, action: "stop publishing", expected: "runs suspended" },
      ],
      now: at,
    });
    await store.runbooks.upsert(rb);

    const byMode = await store.runbooks.list("ws-1", {
      modeId: "artifact_store",
    });
    expect(byMode.map((item) => item.runbookId)).toEqual([rb.runbookId]);

    const drill = newRunbookDrill({
      workspaceId: "ws-1",
      runbookId: rb.runbookId,
      modeId: rb.modeId,
      executedBy: "alice",
      outcome: "pass",
      notes: "drilled in staging",
    });
    await store.drills.recordRunbookDrill(drill);

    const drills = await store.drills.listRunbookDrills(rb.runbookId);
    expect(drills.map((item) => item.outcome)).toEqual(["pass"]);

    const coverage = runbookCoverage(
      await store.runbooks.list("ws-1"),
      await store.drills.listRunbookDrillsByWorkspace("ws-1"),
    );
    expect(coverage.coveredModes).toContain("artifact_store");
  });

  it("records RTO/RPO recovery drills and exposes the latest", async () => {
    const store = await localStore();
    const pass = newRecoveryDrill({
      executedBy: "alice",
      measuredRtoMinutes: 120,
      measuredRpoMinutes: 240,
      integrityPass: true,
      kitdRollbackRef: "kitd.jsonl#42",
      now: "2026-11-15T00:00:00.000Z",
    });
    const fail = newRecoveryDrill({
      executedBy: "alice",
      measuredRtoMinutes: 400,
      measuredRpoMinutes: 60,
      integrityPass: true,
      now: "2026-11-16T00:00:00.000Z",
    });
    await store.drills.recordRecoveryDrill(pass);
    await store.drills.recordRecoveryDrill(fail);

    const list = await store.drills.listRecoveryDrills();
    expect(list.map((item) => item.outcome).sort()).toEqual(["fail", "pass"]);

    const latest = await store.drills.latestRecoveryDrill();
    expect(latest?.drillId).toBe(fail.drillId);
    expect(latest?.script).toBe("smoke:recovery");
    expect(latest?.kitdRollbackRef).toBeNull();
  });
});
