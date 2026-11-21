import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendActivity } from "@kit/activity";
import { appendOp, initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import { collectEvidence } from "./collect";
import { buildGateReport } from "./model";

const NOW = "2026-11-20T12:00:00.000Z";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function seedStore(home: string): Promise<string> {
  const dbPath = path.join(home, "data", "kit.db");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: home,
      KIT_BLOB_ROOT: path.join(home, "blobs"),
    }),
  );
  await appendActivity(store, {
    runId: "run_1",
    kind: "run.lease.claimed",
    status: "claimed",
    createdAt: "2026-11-19T10:00:00.000Z",
  });
  await appendActivity(store, {
    agentId: "operator",
    kind: "workshop.component.assembled",
    status: "completed",
    createdAt: "2026-11-19T10:01:00.000Z",
  });
  await appendActivity(store, {
    agentId: "operator",
    kind: "factory.batch_approved",
    status: "completed",
    createdAt: "2026-11-19T10:02:00.000Z",
  });
  await appendOp(store, {
    entityKind: "store_lock",
    entityId: "kit:autopilot:default",
    op: "lock.acquired",
    actor: "store:test",
    origin: "system",
    createdAt: "2026-11-19T10:03:00.000Z",
  });
  await store.close();
  return dbPath;
}

async function writeTthw(home: string): Promise<void> {
  await writeFile(
    path.join(home, "cold-start-tthw.json"),
    JSON.stringify({
      apiVersion: "agentteam/v1",
      kind: "ZeroConfigTthw",
      startedAt: "2026-11-19T10:00:00.000Z",
      readyAt: "2026-11-19T10:04:30.000Z",
      updatedAt: "2026-11-19T10:04:30.000Z",
      milestones: {
        profile: {
          at: "2026-11-19T10:04:30.000Z",
          flow: "kit-bootstrap",
          modelLatencyMs: 0,
        },
      },
      modelLatencyMs: 0,
      tthwMinutes: 4.5,
      measure: "profile",
      mode: "local",
    }),
    "utf8",
  );
}

function g8(report: ReturnType<typeof buildGateReport>) {
  const gate = report.gates.find((item) => item.id === "G8");
  if (!gate) {
    throw new Error("G8 missing");
  }
  return gate;
}

describe("collectEvidence production sources", () => {
  it("reads activity and op-log evidence plus the TTHW ledger", async () => {
    const home = await tempDir("kit-collect-home-");
    const repoRoot = await tempDir("kit-collect-repo-");
    const dbPath = await seedStore(home);
    await mkdir(path.join(repoRoot, "packs", "tech-radar"), {
      recursive: true,
    });
    await writeFile(
      path.join(repoRoot, "packs", "tech-radar", "components.lock.json"),
      JSON.stringify({ components: [{ kind: "agent", id: "reviewer" }] }),
      "utf8",
    );
    await writeTthw(home);

    const bundle = await collectEvidence({
      home,
      repoRoot,
      now: NOW,
      days: 7,
      dbPath,
    });

    expect(bundle.concurrencyEvidence.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["run.lease.claimed", "lock.acquired"]),
    );
    expect(bundle.workshopEvidence).toHaveLength(1);
    expect(bundle.factoryEvidence).toHaveLength(1);
    expect(bundle.installedComponents).toHaveLength(1);
    expect(bundle.coldStart?.tthwMinutes).toBe(4.5);

    const checks = new Map(
      g8(buildGateReport(bundle)).checks.map((c) => [c.code, c.ok]),
    );
    expect(checks.get("S9.concurrency")).toBe(true);
    expect(checks.get("S10.workshop")).toBe(true);
    expect(checks.get("S11.pixel-factory")).toBe(true);
    // S12 still depends on the cold-start package, which this fixture lacks.
    expect(checks.get("S12.zero-config")).toBe(false);
  });

  it("leaves empty sources as GAPs instead of synthetic values", async () => {
    const home = await tempDir("kit-collect-empty-home-");
    const repoRoot = await tempDir("kit-collect-empty-repo-");
    await mkdir(path.join(home, "data"), { recursive: true });
    const dbPath = path.join(home, "data", "kit.db");

    const bundle = await collectEvidence({
      home,
      repoRoot,
      now: NOW,
      days: 7,
      dbPath,
    });

    expect(bundle.concurrencyEvidence).toEqual([]);
    expect(bundle.workshopEvidence).toEqual([]);
    expect(bundle.factoryEvidence).toEqual([]);
    expect(bundle.coldStart?.tthwMinutes).toBeNull();

    const checks = new Map(
      g8(buildGateReport(bundle)).checks.map((c) => [c.code, c.ok]),
    );
    expect(checks.get("S9.concurrency")).toBe(false);
    expect(checks.get("S11.pixel-factory")).toBe(false);
    expect(checks.get("S12.zero-config")).toBe(false);
  });
});
