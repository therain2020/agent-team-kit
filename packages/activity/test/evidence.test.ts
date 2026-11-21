import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import { GATE_EVIDENCE_KIND, listActivity, recordGateEvidence } from "../src";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-evidence-"));
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

describe("gate evidence", () => {
  it("writes canonical kinds into the activity stream", async () => {
    const store = await sqliteStore();
    await recordGateEvidence(store, {
      runId: "run_1",
      kind: GATE_EVIDENCE_KIND.runLeaseClaimed,
      status: "claimed",
      summary: "claimed by test",
      payload: { leaseVersion: 2 },
    });
    await recordGateEvidence(store, {
      agentId: "operator",
      kind: GATE_EVIDENCE_KIND.factoryBatchApproved,
      status: "completed",
      payload: { batchId: "batch_1", succeeded: 2 },
    });

    const lease = await listActivity(store, { kind: "run.lease.claimed" });
    expect(lease).toHaveLength(1);
    expect(lease[0]?.status).toBe("claimed");
    expect(lease[0]?.agentId).toBe("system");

    const factory = await listActivity(store, {
      kind: "factory.batch_approved",
    });
    expect(factory).toHaveLength(1);
    expect(factory[0]?.agentId).toBe("operator");
  });

  it("kinds match the gate collector's concurrency/workshop/factory probes", () => {
    expect(GATE_EVIDENCE_KIND.runLeaseClaimed).toMatch(
      /(?:^|[.:_-])(lock|fence|lease|concurr|serializ)/i,
    );
    expect(GATE_EVIDENCE_KIND.workshopComponentAssembled).toMatch(
      /workshop|component|dag/i,
    );
    expect(GATE_EVIDENCE_KIND.workshopComponentInstalled).toMatch(
      /workshop|component|dag/i,
    );
    expect(GATE_EVIDENCE_KIND.workshopDagUpdated).toMatch(
      /workshop|component|dag/i,
    );
    expect(GATE_EVIDENCE_KIND.factoryBatchApproved).toMatch(/factory/i);
    expect(GATE_EVIDENCE_KIND.factoryBatchRejected).toMatch(/factory/i);
  });
});
