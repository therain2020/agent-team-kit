import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Run } from "@kit/core";
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

async function sqliteStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-origin-"));
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

function run(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    runId: "run_origin_1",
    eventId: "evt_origin_1",
    workspaceId: "default",
    workflowId: "demo",
    workflowVersion: "1.0",
    runMode: "DRY_RUN",
    status: "running",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("run origin persistence", () => {
  it("round-trips origin kind, trigger id, and trigger run id", async () => {
    const store = await sqliteStore();
    await store.runs.create(
      run({
        originKind: "schedule",
        triggerId: "trig_daily",
        triggerRunId: "trun_1",
      }),
    );

    const stored = await store.runs.get("run_origin_1");
    expect(stored?.originKind).toBe("schedule");
    expect(stored?.triggerId).toBe("trig_daily");
    expect(stored?.triggerRunId).toBe("trun_1");

    const [listed] = await store.runs.list({ limit: 10 });
    expect(listed?.originKind).toBe("schedule");
  });

  it("reads pre-upgrade rows without origin columns as unknown", async () => {
    const store = await sqliteStore();
    const now = new Date().toISOString();
    // Shape of a row written before #92: no origin_kind/trigger columns set.
    await store.sql`
      INSERT INTO runs (
        run_id, event_id, workspace_id, workflow_id, workflow_version,
        run_mode, status, created_at, updated_at
      ) VALUES (
        'run_legacy', 'evt_legacy', 'default', 'demo', '1.0',
        'DRY_RUN', 'paused', ${now}, ${now}
      )
    `;

    const legacy = await store.runs.get("run_legacy");
    expect(legacy?.originKind).toBe("unknown");
    expect(legacy?.triggerId).toBeUndefined();
    expect(legacy?.triggerRunId).toBeUndefined();
  });
});
