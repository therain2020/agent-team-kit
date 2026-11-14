import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KillSwitchTrippedError } from "@kit/core";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingChange } from "../src/pending";
import { abortJob, getJob, listJobs, startJob } from "../src/service";
import { JobError } from "../src/types";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-job-"));
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

describe("job control", () => {
  it("starts a DRY_RUN pack run through the local queue", async () => {
    const store = await sqliteStore();
    const result = await startJob(
      store,
      {
        kind: "packRun",
        packDir: "tech-radar",
        origin: "cli",
        runMode: "DRY_RUN",
        stub: true,
      },
      { repoRoot: process.cwd() },
    );

    expect(result.kind).toBe("packRun");
    expect(result.engine).toBe("local");
    expect(result.runMode).toBe("DRY_RUN");
    expect(result.requestId).toBeTruthy();

    const request = await store.runRequests.find(result.jobId);
    expect(request?.status).toBe("queued");
  }, 30_000);

  it("refuses to start a run while a kill switch is active", async () => {
    const store = await sqliteStore();
    const now = new Date().toISOString();
    await store.killSwitches.activate({
      switchId: "kill_job",
      scope: "global",
      target: "",
      workspaceId: null,
      state: "active",
      activatedBy: "operator",
      reason: "drill",
      activatedAt: now,
      releasedBy: null,
      releasedAt: null,
      releaseReason: null,
      version: 1,
      updatedAt: now,
    });

    await expect(
      startJob(
        store,
        {
          kind: "packRun",
          packDir: "tech-radar",
          origin: "cli",
          runMode: "DRY_RUN",
          stub: true,
        },
        { repoRoot: process.cwd() },
      ),
    ).rejects.toBeInstanceOf(KillSwitchTrippedError);
  });

  it("rejects a web job outside packs/", async () => {
    const store = await sqliteStore();
    await expect(
      startJob(
        store,
        {
          kind: "packRun",
          packDir: "../outside",
          origin: "web",
        },
        { repoRoot: process.cwd() },
      ),
    ).rejects.toMatchObject({ code: "pack_outside_root" });
  });

  it("starts a DRY_RUN iteration through the local queue", async () => {
    const store = await sqliteStore();
    const result = await startJob(
      store,
      {
        kind: "iteration",
        packDir: "self-improve",
        goal: "find a weakness",
        origin: "cli",
        runMode: "DRY_RUN",
      },
      { repoRoot: process.cwd() },
    );

    expect(result.kind).toBe("iteration");
    expect(result.engine).toBe("local");
    expect(result.requestId).toBeTruthy();

    const request = await store.runRequests.find(result.jobId);
    expect(request?.kind).toBe("iteration");
    expect(request?.status).toBe("queued");

    const job = await getJob(store, "iteration", result.jobId);
    expect(job?.status).toBe("running");
    expect(job?.phase).toBe("queued");
  }, 30_000);

  it("cancels a queued local iteration and its run", async () => {
    const store = await sqliteStore();
    const result = await startJob(
      store,
      {
        kind: "iteration",
        packDir: "self-improve",
        goal: "find a weakness",
        origin: "cli",
        runMode: "DRY_RUN",
      },
      { repoRoot: process.cwd() },
    );

    const aborted = await abortJob(store, "iteration", result.jobId, {
      repoRoot: process.cwd(),
    });
    expect(aborted.cancelled).toBe(true);
    expect((await store.runRequests.find(result.jobId))?.status).toBe(
      "cancelled",
    );
    expect((await getJob(store, "iteration", result.jobId))?.status).toBe(
      "cancelled",
    );
  }, 30_000);

  it("lists and reads iterations, and refuses to abort finished jobs", async () => {
    const store = await sqliteStore();
    const now = new Date().toISOString();
    await store.sql`
      INSERT INTO iteration_runs (
        iteration_id, workflow_id, workspace_id, goal, acceptance, run_mode,
        apply_mode, status, phase, started_at, updated_at
      ) VALUES (
        'it_test_1', 'iteration-it_test_1', 'default', 'test goal', NULL,
        'DRY_RUN', 'none', 'succeeded', 'reported', ${now}, ${now}
      )
    `;

    const jobs = await listJobs(store, { kind: "iteration" });
    expect(jobs.some((job) => job.jobId === "it_test_1")).toBe(true);

    const job = await getJob(store, "iteration", "it_test_1");
    expect(job?.goal).toBe("test goal");

    await expect(
      abortJob(store, "iteration", "it_test_1", {
        repoRoot: process.cwd(),
      }),
    ).rejects.toMatchObject({ code: "already_finished" });
  });

  it("requires a note before applying a pending change", async () => {
    const store = await sqliteStore();
    await expect(
      applyPendingChange(store, "tkt_missing", {
        actor: "test",
        note: " ",
        repoRoot: process.cwd(),
      }),
    ).rejects.toBeInstanceOf(JobError);
  });
});
