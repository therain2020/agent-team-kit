import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EventEnvelope, Run, Stage } from "@kit/core";
import SqliteClient from "better-sqlite3";
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

async function localConfig() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-sqlite-"));
  dirs.push(dir);
  return loadStoreConfig({
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: dir,
    KIT_BLOB_ROOT: path.join(dir, "blobs"),
  });
}

function event(): EventEnvelope {
  const now = new Date().toISOString();
  return {
    eventId: "evt_local_1",
    type: "demo.event.received",
    schemaVersion: "1.0",
    occurredAt: now,
    receivedAt: now,
    workspaceId: "default",
    idempotencyKey: "idem-local-1",
    traceId: "trace-local-1",
    payloadRef: "inline:{}",
  };
}

function run(): Run {
  const now = new Date().toISOString();
  return {
    runId: "run_local_1",
    eventId: "evt_local_1",
    workspaceId: "default",
    workflowId: "demo",
    workflowVersion: "1.0",
    runMode: "DRY_RUN",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
}

function stage(): Stage {
  return {
    stageId: "run_local_1:echo",
    runId: "run_local_1",
    name: "echo",
    status: "pending",
  };
}

describe("sqlite embedded store", () => {
  it("creates the schema and round-trips runs, artifacts, and autopilot state", async () => {
    const config = await localConfig();
    expect(config.driver).toBe("sqlite");
    const store = await initStore(config);
    closers.push(() => store.close());

    expect(await store.events.insert(event())).toEqual({ inserted: true });
    expect(await store.events.insert(event())).toEqual({ inserted: false });
    await store.runs.create(run());
    await store.stages.create(stage());
    await store.stages.updateStatus(stage().stageId, "succeeded", {
      finishedAt: new Date().toISOString(),
    });

    const published = await store.artifactService.publish({
      workspaceId: "default",
      content: new TextEncoder().encode("hello embedded sqlite"),
      producer: {
        agentId: "echo",
        agentVersion: "1.0.0",
        promptHash: "hash",
        modelId: "stub",
      },
      inputs: [],
      runId: "run_local_1",
      stageId: "run_local_1:echo",
      runMode: "DRY_RUN",
      cost: { currency: "CNY", amount: 0, tokens: 0 },
      sensitivity: "internal",
      retentionClass: "artifact_365d",
    });
    expect(published.artifact.artifactId).toMatch(/^art_/);

    const runs = await store.runs.list({ limit: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("run_local_1");

    const stages = await store.stages.listByRun("run_local_1");
    expect(stages[0]?.status).toBe("succeeded");

    const artifacts = await store.artifactStore.listByRun("run_local_1");
    expect(artifacts).toHaveLength(1);
    const manifest = await store.manifests.get(published.artifact.manifestId);
    expect(manifest?.producer.agentId).toBe("echo");
    expect(manifest?.cost).toEqual({ currency: "CNY", amount: 0, tokens: 0 });

    await store.autopilotState.insertIfMissing({
      workspaceId: "default",
      packDir: "minimal",
      enabled: true,
      lastTickAt: null,
      nextRuns: { daily: "2026-11-16T00:00:00.000Z" },
      day: "2026-11-15",
      runsToday: 2,
      spentToday: 0.15,
      lastError: null,
      updatedAt: new Date().toISOString(),
      version: 0,
    });
    const state = await store.autopilotState.get("default", "minimal");
    expect(state?.enabled).toBe(true);
    expect(state?.spentToday).toBeCloseTo(0.15);
    expect(state?.nextRuns.daily).toBe("2026-11-16T00:00:00.000Z");
    expect(state?.version).toBe(0);
    if (!state) {
      throw new Error("missing autopilot state");
    }
    const stale = { ...state };
    state.lastError = "updated";
    expect(await store.autopilotState.update(state)).toBe(true);
    expect(state.version).toBe(1);
    expect(await store.autopilotState.update(stale)).toBe(false);

    await store.ping();
  }, 60_000);

  it("accumulates manager session usage and rolls the window", async () => {
    const config = await localConfig();
    const store = await initStore(config);
    closers.push(() => store.close());

    const first = await store.managerSessions.addUsage({
      workspaceId: "default",
      sessionId: "run_manager_1",
      tokens: 9000,
      costCny: 1.2,
      now: "2026-11-15T10:00:00.000Z",
      windowMs: 180_000,
    });
    expect(first.tokens).toBe(9000);
    expect(first.costCny).toBeCloseTo(1.2);
    expect(first.exchanges).toBe(1);
    expect(first.rejections).toBe(0);
    expect(first.windowStartedAt).toBe("2026-11-15T10:00:00.000Z");
    expect(first.windowEndsAt).toBe("2026-11-15T10:03:00.000Z");

    const second = await store.managerSessions.addUsage({
      workspaceId: "default",
      sessionId: "run_manager_1",
      tokens: 500,
      costCny: 0.2,
      now: "2026-11-15T10:01:00.000Z",
      windowMs: 180_000,
    });
    expect(second.tokens).toBe(9500);
    expect(second.costCny).toBeCloseTo(1.4);
    expect(second.exchanges).toBe(2);
    expect(second.firstAt).toBe("2026-11-15T10:00:00.000Z");
    expect(second.lastAt).toBe("2026-11-15T10:01:00.000Z");

    const rejected = await store.managerSessions.recordRejection({
      workspaceId: "default",
      sessionId: "run_manager_1",
      reason: "tokens",
      now: "2026-11-15T10:01:30.000Z",
      windowMs: 180_000,
    });
    expect(rejected.rejections).toBe(1);
    expect(rejected.lastRejectionReason).toBe("tokens");
    expect(rejected.tokens).toBe(9500);
    expect(rejected.costCny).toBeCloseTo(1.4);

    const rolled = await store.managerSessions.addUsage({
      workspaceId: "default",
      sessionId: "run_manager_1",
      tokens: 100,
      costCny: 0.1,
      now: "2026-11-15T10:03:00.000Z",
      windowMs: 180_000,
    });
    expect(rolled.tokens).toBe(100);
    expect(rolled.costCny).toBeCloseTo(0.1);
    expect(rolled.exchanges).toBe(1);
    expect(rolled.rejections).toBe(0);
    expect(rolled.firstAt).toBe("2026-11-15T10:03:00.000Z");

    expect(
      await store.managerSessions.get("other", "run_manager_1"),
    ).toBeNull();

    await store.managerSessions.reset("default", "run_manager_1");
    expect(
      await store.managerSessions.get("default", "run_manager_1"),
    ).toBeNull();
  }, 60_000);

  it("claims a run request once and reclaims it after the lease goes stale", async () => {
    const config = await localConfig();
    const store = await initStore(config);
    closers.push(() => store.close());
    const now = new Date().toISOString();

    await store.runRequests.enqueue({
      requestId: "rrq_1",
      runId: "run_queue_1",
      workspaceId: "default",
      workflowId: "demo",
      kind: "iteration",
      payload: JSON.stringify({ runId: "run_queue_1" }),
      createdAt: now,
      updatedAt: now,
    });

    const first = await store.runRequests.claimNext(
      "worker-a",
      new Date(),
      60_000,
    );
    expect(first?.status).toBe("claimed");
    expect(first?.claimedBy).toBe("worker-a");
    expect(first?.kind).toBe("iteration");

    const second = await store.runRequests.claimNext(
      "worker-b",
      new Date(),
      60_000,
    );
    expect(second).toBeNull();

    const later = new Date(Date.now() + 120_000);
    const reclaimed = await store.runRequests.claimNext(
      "worker-b",
      later,
      60_000,
    );
    expect(reclaimed?.claimedBy).toBe("worker-b");

    await store.runRequests.finish("rrq_1", "done");
    expect((await store.runRequests.find("run_queue_1"))?.status).toBe("done");

    await store.runRequests.finish("rrq_1", "cancelled", "aborted by operator");
    const cancelled = await store.runRequests.find("run_queue_1");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.error).toBe("aborted by operator");
  }, 60_000);

  it("keeps data across close and reopen", async () => {
    const config = await localConfig();
    const first = await initStore(config);
    await first.events.insert(event());
    await first.runs.create(run());
    await first.close();

    const second = await initStore(config);
    closers.push(() => second.close());
    const runs = await second.runs.list({ limit: 5 });
    expect(runs.map((item) => item.runId)).toEqual(["run_local_1"]);
  }, 60_000);

  it("adds the approvals risk column to an existing sqlite store", async () => {
    const config = await localConfig();
    await mkdir(path.dirname(config.localDbPath), { recursive: true });

    // Pre-risk approvals table: every column of the current schema except
    // risk_class, plus one decided row that must survive the migration.
    const legacy = new SqliteClient(config.localDbPath);
    legacy.exec(`
      CREATE TABLE approvals (
        approval_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        stage_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        requester TEXT NOT NULL,
        required_role TEXT,
        payload_ref TEXT,
        sla_due_at TEXT,
        expires_at TEXT,
        decision_by TEXT,
        decision_at TEXT,
        decision_reason TEXT,
        assignee TEXT,
        assigned_at TEXT,
        subject_ref TEXT,
        substrate TEXT,
        change_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO approvals (
          approval_id, workspace_id, run_id, kind, status, requester,
          decision_by, decision_at, decision_reason, version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "apr_legacy",
        "default",
        "run_legacy",
        "stage_before",
        "approved",
        "manager",
        "operator",
        "2026-11-15T01:00:00.000Z",
        "looked fine",
        2,
        "2026-11-15T00:00:00.000Z",
      );
    legacy.close();

    const store = await initStore(config);
    closers.push(() => store.close());

    const preserved = await store.approvals.get("apr_legacy");
    expect(preserved?.status).toBe("approved");
    // The old row has no evidence of a risk class; it must stay unlabelled.
    expect(preserved?.riskClass).toBeNull();

    const typed = await store.approvals.enqueue({
      approvalId: "apr_new",
      workspaceId: "default",
      runId: "run_legacy",
      kind: "stage_before",
      riskClass: "high",
    });
    expect(typed.riskClass).toBe("high");
    await store.close();

    // Re-running the migration is idempotent.
    const again = await initStore(config);
    closers.push(() => again.close());
    expect((await again.approvals.get("apr_new"))?.riskClass).toBe("high");
    expect((await again.approvals.get("apr_legacy"))?.riskClass).toBeNull();
  }, 60_000);
});
