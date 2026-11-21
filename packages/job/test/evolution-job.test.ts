import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import { startJob } from "../src/service";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
const previousHiddenRoot = process.env.KIT_HIDDEN_EVALS_ROOT;

afterEach(async () => {
  if (previousHiddenRoot === undefined) {
    Reflect.deleteProperty(process.env, "KIT_HIDDEN_EVALS_ROOT");
  } else {
    process.env.KIT_HIDDEN_EVALS_ROOT = previousHiddenRoot;
  }
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const HIDDEN_SUITE = `version: 1
cases:
  - id: std-1
    evidence: "scheduled evidence"
    expect:
      contains: ["[stub]"]
`;

/** Write the hidden suite the autopilot trigger must use for workspace default. */
async function useHiddenSuite(dir: string): Promise<string> {
  const hiddenRoot = path.join(dir, "hidden-evals");
  process.env.KIT_HIDDEN_EVALS_ROOT = hiddenRoot;
  const suiteDir = path.join(hiddenRoot, "default");
  await mkdir(suiteDir, { recursive: true });
  await writeFile(path.join(suiteDir, "suite.yaml"), HIDDEN_SUITE, "utf8");
  return hiddenRoot;
}

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
  it("runs the existing cycle with the hidden suite and returns it as the job record", async () => {
    const { dir, store, evidenceFile } = await setup();
    const hiddenRoot = await useHiddenSuite(dir);

    const result = await startEvolutionJob(store, dir, evidenceFile);

    expect(result.kind).toBe("evolution");
    expect(result.jobId).toMatch(/^cyc_/);
    expect(result.workflowId).toBe(`evolution-${result.jobId}`);

    const rows = await store.sql<
      Array<{
        decision: string;
        budget_status: string | null;
        hidden: string | null;
      }>
    >`
      SELECT decision, budget_status, hidden FROM evolution_cycles
      WHERE cycle_id = ${result.jobId} LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).not.toBe("failed");
    expect(rows[0]?.decision).not.toBe("skipped");
    // The shared ledger admitted the cycle (#86); cycles are never unledgered
    // when started through the job service.
    expect(rows[0]?.budget_status).toBe("admitted");
    // Autopilot triggers resolve the same hidden directory as the CLI (70 §5).
    const hidden = JSON.parse(rows[0]?.hidden ?? "{}") as Record<
      string,
      unknown
    >;
    expect(hidden).toMatchObject({
      available: true,
      required: true,
      status: "available",
      dir: path.join(hiddenRoot, "default"),
    });
  }, 60_000);

  it("skips explicitly when the hidden suite is missing", async () => {
    const { dir, store, evidenceFile } = await setup();
    process.env.KIT_HIDDEN_EVALS_ROOT = path.join(dir, "missing-hidden-evals");

    const result = await startEvolutionJob(store, dir, evidenceFile);

    const rows = await store.sql<
      Array<{ decision: string; rationale: string; hidden: string | null }>
    >`
      SELECT decision, rationale, hidden FROM evolution_cycles
      WHERE cycle_id = ${result.jobId} LIMIT 1
    `;
    expect(rows[0]?.decision).toBe("skipped");
    expect(rows[0]?.rationale).toContain("hidden eval set unavailable");
    expect(rows[0]?.rationale).toContain("refusing to score");
    const hidden = JSON.parse(rows[0]?.hidden ?? "{}") as Record<
      string,
      unknown
    >;
    expect(hidden).toMatchObject({
      available: false,
      required: true,
      status: "missing",
    });
    expect(hidden.reason).toContain("hidden eval directory missing");
  }, 60_000);
});

async function startEvolutionJob(
  store: Awaited<ReturnType<typeof setup>>["store"],
  dir: string,
  evidenceFile: string,
) {
  return await startJob(
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
      origin: {
        kind: "schedule",
        triggerId: "tech-radar:evolution",
        actor: "trigger-dispatch",
      },
    },
    { repoRoot: process.cwd() },
  );
}
