import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import { appendActivity } from "../src/index";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-activity-proj-"));
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

interface ProjectionRow {
  run_id: string;
  workspace_id: string;
  status: string;
  current_stage: string | null;
  last_event_id: number;
  version: number;
}

describe("activity-driven run projection", () => {
  it("writes the run_projection row through appendActivity", async () => {
    const store = await sqliteStore();
    const eventId = await appendActivity(store, {
      runId: "run_1",
      stageId: "run_1:collect",
      agentId: "researcher",
      kind: "stage.started",
      status: "running",
      summary: "collect",
      createdAt: "2026-11-19T10:00:00.000Z",
    });

    const rows = await store.sql<ProjectionRow[]>`
      SELECT run_id, workspace_id, status, current_stage, last_event_id, version
      FROM run_projection WHERE run_id = ${"run_1"}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: "run_1",
      workspace_id: "default",
      status: "running",
      current_stage: "run_1:collect",
      last_event_id: eventId,
      version: 1,
    });

    const nextEventId = await appendActivity(store, {
      runId: "run_1",
      kind: "run.finished",
      status: "succeeded",
      createdAt: "2026-11-19T10:01:00.000Z",
    });
    const [finished] = await store.sql<ProjectionRow[]>`
      SELECT run_id, workspace_id, status, current_stage, last_event_id, version
      FROM run_projection WHERE run_id = ${"run_1"}
    `;
    expect(finished).toMatchObject({
      status: "succeeded",
      last_event_id: nextEventId,
      version: 2,
    });
  });

  it("does not project run-less events", async () => {
    const store = await sqliteStore();
    await appendActivity(store, {
      agentId: "ops",
      kind: "ops.autonomy.enabled",
      status: "active",
    });
    const rows = await store.sql<Array<{ count: number }>>`
      SELECT COUNT(*) AS count FROM run_projection
    `;
    expect(Number(rows[0]?.count)).toBe(0);
  });
});
