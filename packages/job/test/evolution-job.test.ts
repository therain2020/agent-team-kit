import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-evolution-job-"));
  dirs.push(dir);
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: path.join(dir, ".kit"),
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
  closers.push(() => store.close());
  const evidenceFile = path.join(dir, "evidence.json");
  await writeFile(
    evidenceFile,
    JSON.stringify({
      generatedAt: "2026-11-21T00:00:00.000Z",
      sources: [
        {
          citationId: "S1",
          title: "Example",
          url: "https://example.com/a",
          summary: "A verifiable item.",
        },
      ],
      errors: [],
    }),
    "utf8",
  );
  return { dir, store, evidenceFile };
}

describe("evolution job", () => {
  it("runs the existing cycle and returns the cycle as the job record", async () => {
    const { dir, store, evidenceFile } = await setup();

    const result = await startJob(
      store,
      {
        kind: "evolution",
        packDir: "tech-radar",
        runMode: "DRY_RUN",
        stub: true,
        evolution: {
          evidenceFile,
          agentId: "writer",
          force: true,
          variantsRoot: path.join(dir, "variants"),
          cyclesRoot: path.join(dir, "cycles"),
        },
        origin: { kind: "schedule", triggerId: "tech-radar:evolution" },
      },
      { repoRoot: process.cwd() },
    );

    expect(result.kind).toBe("evolution");
    expect(result.jobId).toMatch(/^cyc_/);
    expect(result.workflowId).toBe(`evolution-${result.jobId}`);

    const rows = await store.sql<
      Array<{ decision: string; budget_status: string | null }>
    >`
      SELECT decision, budget_status FROM evolution_cycles
      WHERE cycle_id = ${result.jobId} LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).not.toBe("failed");
    // The shared ledger admitted the cycle (#86); cycles are never unledgered
    // when started through the job service.
    expect(rows[0]?.budget_status).toBe("admitted");
  }, 60_000);
});
