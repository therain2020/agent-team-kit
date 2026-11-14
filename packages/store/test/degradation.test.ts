import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import type { DegradationStateRecord } from "../src/repositories";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-degradation-"));
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

const record: DegradationStateRecord = {
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
};

describe("degradation store", () => {
  it("round-trips modes and audits, and exits only active modes", async () => {
    const store = await localStore();

    await store.degradation.upsert(record);
    expect(await store.degradation.listActive()).toHaveLength(1);
    expect(await store.degradation.get("workspace", "ws-1")).toMatchObject({
      modeId: "deg_1",
      qualityFloor: { minChars: 20 },
      exitCriteria: { minStableMinutes: 5 },
    });
    expect(await store.degradation.get("workspace", "ws-2")).toBeNull();

    await store.degradation.appendAudit({
      auditId: "aud_1",
      occurredAt: "2026-11-15T00:00:01.000Z",
      actor: "tester",
      action: "enter",
      scope: "workspace",
      workspaceId: "ws-1",
      modeId: "deg_1",
      detail: { reason: "provider down" },
    });
    expect(await store.degradation.listAudit()).toMatchObject([
      { auditId: "aud_1", action: "enter" },
    ]);

    expect(
      await store.degradation.markExited(
        "workspace",
        "ws-1",
        "2026-11-15T01:00:00.000Z",
        "recovered",
      ),
    ).toBe(true);
    expect(
      await store.degradation.markExited(
        "workspace",
        "ws-1",
        "2026-11-15T01:00:00.000Z",
        "recovered",
      ),
    ).toBe(false);
    expect(await store.degradation.listActive()).toHaveLength(0);
    expect(await store.degradation.get("workspace", "ws-1")).toMatchObject({
      status: "exited",
      exitReason: "recovered",
    });
  });
});
