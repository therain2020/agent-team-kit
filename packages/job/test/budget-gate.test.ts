import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cnyToMicro } from "@kit/core";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import { startJob } from "../src/service";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-job-budget-"));
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

describe("job budget admission", () => {
  it("rejects a run whose estimate exceeds its hard run budget", async () => {
    const store = await sqliteStore();
    await expect(
      startJob(
        store,
        {
          kind: "packRun",
          packDir: "tech-radar",
          origin: "cli",
          runMode: "DRY_RUN",
          stub: true,
          budget: { run: { cny: 0.000001 } },
        },
        { repoRoot: process.cwd() },
      ),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
  }, 30_000);

  it("admits a run under the default D-38 budget and records it", async () => {
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

    const runs = await store.budgetService.listBudgets({
      workspaceId: "default",
      scope: "run",
    });
    const run = runs.find((budget) => budget.targetKey === result.jobId);
    expect(run?.limitCnyMicro).toBe(cnyToMicro(5));
    expect(run?.spentCnyMicro).toBe(0);
  }, 30_000);

  it("records explicit stage and agent budgets", async () => {
    const store = await sqliteStore();
    const result = await startJob(
      store,
      {
        kind: "packRun",
        packDir: "tech-radar",
        origin: "cli",
        runMode: "DRY_RUN",
        stub: true,
        budget: {
          run: { cny: 5 },
          stage: { cny: 2 },
          agent: { cny: 1 },
        },
      },
      { repoRoot: process.cwd() },
    );

    const stage = await store.budgetService.listBudgets({
      workspaceId: "default",
      scope: "stage",
      targetPrefix: result.jobId,
    });
    const agent = await store.budgetService.listBudgets({
      workspaceId: "default",
      scope: "agent",
      targetPrefix: result.jobId,
    });
    expect(stage.length).toBeGreaterThan(0);
    expect(agent.length).toBeGreaterThan(0);
    expect(
      stage.every((budget) => budget.limitCnyMicro === cnyToMicro(2)),
    ).toBe(true);
    expect(
      agent.every((budget) => budget.limitCnyMicro === cnyToMicro(1)),
    ).toBe(true);
  }, 30_000);
});
