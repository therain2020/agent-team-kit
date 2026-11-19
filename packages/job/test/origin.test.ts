import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import { getJob, listJobs, startJob } from "../src/service";
import { normalizeJobOrigin } from "../src/types";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-job-origin-"));
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

describe("job origin", () => {
  it("normalizes legacy string origins into a structured record", () => {
    expect(normalizeJobOrigin("cli")).toEqual({
      kind: "cli",
      actor: "operator:cli",
    });
    expect(normalizeJobOrigin(undefined)).toEqual({
      kind: "api",
      actor: "operator:api",
    });
    expect(
      normalizeJobOrigin({
        kind: "schedule",
        triggerId: "trig_daily",
        actor: "policy:autopilot",
      }),
    ).toEqual({
      kind: "schedule",
      triggerId: "trig_daily",
      actor: "policy:autopilot",
    });
  });

  it("persists a structured origin on new iterations", async () => {
    const store = await sqliteStore();
    const result = await startJob(
      store,
      {
        kind: "iteration",
        packDir: "self-improve",
        goal: "find a weakness",
        runMode: "DRY_RUN",
        origin: {
          kind: "event",
          triggerId: "trig_alert",
          actor: "trigger:alerting",
        },
      },
      { repoRoot: process.cwd() },
    );

    const job = await getJob(store, "iteration", result.jobId);
    expect(job?.originKind).toBe("event");
    expect(job?.triggerId).toBe("trig_alert");
    expect(job?.triggerRunId).toBeNull();
  }, 30_000);

  it("reads historical iterations as unknown without throwing", async () => {
    const store = await sqliteStore();
    const now = new Date().toISOString();
    await store.sql`
      INSERT INTO iteration_runs (
        iteration_id, workflow_id, workspace_id, goal, acceptance, run_mode,
        apply_mode, status, phase, started_at, updated_at
      ) VALUES (
        'it_legacy', 'iteration-it_legacy', 'default', 'old goal', NULL,
        'DRY_RUN', 'none', 'succeeded', 'reported', ${now}, ${now}
      )
    `;

    const job = await getJob(store, "iteration", "it_legacy");
    expect(job?.originKind).toBe("unknown");
    expect(job?.triggerId).toBeNull();

    const jobs = await listJobs(store, { kind: "iteration" });
    const listed = jobs.find((item) => item.jobId === "it_legacy");
    expect(listed?.originKind).toBe("unknown");
  });
});
