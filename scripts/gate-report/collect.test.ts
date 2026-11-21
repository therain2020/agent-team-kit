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

  it("reads automatic reaction signals produced by the reaction dispatcher", async () => {
    const home = await tempDir("kit-collect-reactions-home-");
    const repoRoot = await tempDir("kit-collect-reactions-repo-");
    const dbPath = path.join(home, "data", "kit.db");
    await mkdir(path.dirname(dbPath), { recursive: true });
    const store = await initStore(
      loadStoreConfig({
        KIT_RUNTIME_MODE: "local",
        KIT_HOME: home,
        KIT_BLOB_ROOT: path.join(home, "blobs"),
      }),
    );
    await store.triggerRuns.create({
      triggerRunId: "trg-auto",
      workspaceId: "default",
      triggerId: "information:rule-auto",
      kind: "information",
      routeId: "reaction:rule-auto",
      jobKind: "packRun",
      dedupeKey: "inf_auto:rule-auto",
      jobId: "job-auto",
      status: "started",
      launchedAt: "2026-11-19T10:00:00.000Z",
      estimateCny: 0,
      payloadRef: "information:inf_auto",
      reactionRuleId: "rule-auto",
      lastError: null,
      createdAt: "2026-11-19T10:00:00.000Z",
      updatedAt: "2026-11-19T10:00:00.000Z",
    });
    await store.close();

    const signalsDir = path.join(home, "signals");
    await mkdir(signalsDir, { recursive: true });
    const signal = {
      kind: "reaction.outcome",
      signalId: "rsg_auto0000000001",
      at: "2026-11-19T10:00:00.000Z",
      workspaceId: "default",
      eventId: "inf_auto",
      ruleId: "rule-auto",
      ruleVersion: 1,
      triggerRunId: "trg-auto",
      jobId: "job-auto",
      outcome: "fired",
      gate: "write-back",
      reason: null,
      dedupeKey: "inf_auto:rule-auto",
    };
    await writeFile(
      path.join(signalsDir, "reactions.jsonl"),
      `${[
        JSON.stringify(signal),
        JSON.stringify(signal),
        JSON.stringify({
          at: "2026-11-19T11:00:00.000Z",
          eventId: "inf_auto",
          triggerRunId: "trg-auto",
          useful: true,
          costCny: 0.1,
        }),
        "not json",
      ].join("\n")}\n`,
      "utf8",
    );

    const bundle = await collectEvidence({
      home,
      repoRoot,
      now: NOW,
      days: 7,
      dbPath,
    });

    expect(bundle.reactionSignals).toEqual([
      {
        at: "2026-11-19T10:00:00.000Z",
        eventId: "inf_auto",
        ruleId: "rule-auto",
        triggerRunId: "trg-auto",
        jobId: "job-auto",
        outcome: "fired",
        dedupeKey: "inf_auto:rule-auto",
      },
    ]);
    expect(bundle.reactionSamples).toHaveLength(1);

    const checks = new Map(
      buildGateReport(bundle)
        .gates.find((item) => item.id === "G2")
        ?.checks.map((check) => [check.code, check.ok]),
    );
    expect(checks.get("signals-observed")).toBe(true);
    expect(checks.get("signals-linked")).toBe(true);
    expect(checks.get("samples-present")).toBe(true);
    // Usefulness is still a human judgement; one sample is not a rate yet.
    expect(checks.get("useful-rate")).toBe(true);
  });

  it("keeps reaction signals as GAP when the producer wrote nothing", async () => {
    const home = await tempDir("kit-collect-no-reactions-home-");
    const repoRoot = await tempDir("kit-collect-no-reactions-repo-");
    const dbPath = path.join(home, "data", "kit.db");
    await mkdir(path.dirname(dbPath), { recursive: true });

    const bundle = await collectEvidence({
      home,
      repoRoot,
      now: NOW,
      days: 7,
      dbPath,
    });

    expect(bundle.reactionSignals).toEqual([]);
    const report = buildGateReport(bundle);
    expect(report.gaps).toContain("G2.signals-observed");
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
