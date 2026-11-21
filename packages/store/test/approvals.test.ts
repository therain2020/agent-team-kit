import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Run, Stage } from "@kit/core";
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

async function localStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-approvals-"));
  dirs.push(dir);
  const config = loadStoreConfig({
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: dir,
    KIT_BLOB_ROOT: path.join(dir, "blobs"),
  });
  const store = await initStore(config);
  closers.push(() => store.close());
  return { store, config };
}

function run(runId: string, status: Run["status"] = "paused"): Run {
  const now = "2026-11-15T00:00:00.000Z";
  return {
    runId,
    eventId: `evt_${runId}`,
    workspaceId: "default",
    workflowId: "demo",
    workflowVersion: "1.0",
    runMode: "LIVE",
    status,
    createdAt: now,
    updatedAt: now,
  };
}

function stage(stageId: string, name: string): Stage {
  return {
    stageId,
    runId: stageId.split(":")[0] ?? "run",
    name,
    status: "running",
  };
}

describe("approval service (sqlite)", () => {
  it("enqueues idempotently and lists queued approvals by due time", async () => {
    const { store } = await localStore();
    await store.runs.create(run("run_a"));
    await store.runs.create(run("run_b"));
    await store.runs.create(run("run_c"));
    await store.stages.create(stage("run_a:review", "review"));

    const base = {
      workspaceId: "default",
      kind: "stage_before" as const,
      requester: "manager",
    };
    await store.approvals.enqueue({
      ...base,
      approvalId: "apr_late",
      runId: "run_a",
      stageId: "run_a:review",
      slaDueAt: "2026-11-16T00:00:00.000Z",
      expiresAt: "2026-11-20T00:00:00.000Z",
      createdAt: "2026-11-15T00:00:01.000Z",
    });
    await store.approvals.enqueue({
      ...base,
      approvalId: "apr_early",
      runId: "run_b",
      slaDueAt: "2026-11-15T06:00:00.000Z",
      expiresAt: "2026-11-20T00:00:00.000Z",
      createdAt: "2026-11-15T00:00:02.000Z",
    });
    await store.approvals.enqueue({
      ...base,
      approvalId: "apr_none",
      runId: "run_c",
      slaDueAt: null,
      expiresAt: null,
      createdAt: "2026-11-15T00:00:03.000Z",
    });

    const replayed = await store.approvals.enqueue({
      ...base,
      approvalId: "apr_late",
      runId: "run_a",
      slaDueAt: "2099-01-01T00:00:00.000Z",
    });
    expect(replayed.version).toBe(1);
    expect(replayed.slaDueAt).toBe("2026-11-16T00:00:00.000Z");

    const page = await store.approvals.list({ status: "queued", sort: "due" });
    expect(page.items.map((item) => item.approvalId)).toEqual([
      "apr_none",
      "apr_early",
      "apr_late",
    ]);
    expect(page.items[2]?.workflowId).toBe("demo");
    expect(page.items[2]?.stageName).toBe("review");
    expect(page.nextCursor).toBeNull();
  });

  it("records the risk class and keeps unknown legacy rows null", async () => {
    const { store } = await localStore();
    await store.runs.create(run("run_risk"));

    const typed = await store.approvals.enqueue({
      approvalId: "apr_high",
      workspaceId: "default",
      runId: "run_risk",
      kind: "stage_before",
      riskClass: "high",
    });
    expect(typed.riskClass).toBe("high");

    const legacy = await store.approvals.enqueue({
      approvalId: "apr_legacy",
      workspaceId: "default",
      runId: "run_risk",
      kind: "stage_before",
    });
    expect(legacy.riskClass).toBeNull();

    const reread = await store.approvals.get("apr_high");
    expect(reread?.riskClass).toBe("high");
    const page = await store.approvals.list({ sort: "created" });
    expect(
      page.items.find((item) => item.approvalId === "apr_high")?.riskClass,
    ).toBe("high");
    expect(
      page.items.find((item) => item.approvalId === "apr_legacy")?.riskClass,
    ).toBeNull();

    // Replays must not rewrite the recorded class or invent one for legacy
    // rows: the first write is the evidence of record.
    const replayed = await store.approvals.enqueue({
      approvalId: "apr_legacy",
      workspaceId: "default",
      runId: "run_risk",
      kind: "stage_before",
      riskClass: "low",
    });
    expect(replayed.riskClass).toBeNull();
  });

  it("pages without repeating or dropping approvals", async () => {
    const { store } = await localStore();
    for (const id of ["a", "b", "c"]) {
      await store.runs.create(run(`run_${id}`));
      await store.approvals.enqueue({
        approvalId: `apr_${id}`,
        workspaceId: "default",
        runId: `run_${id}`,
        kind: "stage_before",
        slaDueAt: `2026-11-1${id === "a" ? 1 : id === "b" ? 2 : 3}T00:00:00.000Z`,
        expiresAt: "2026-11-20T00:00:00.000Z",
      });
    }

    const first = await store.approvals.list({ sort: "due", limit: 2 });
    expect(first.items.map((item) => item.approvalId)).toEqual([
      "apr_a",
      "apr_b",
    ]);
    expect(first.nextCursor).toBeTruthy();

    const second = await store.approvals.list({
      sort: "due",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.approvalId)).toEqual(["apr_c"]);
    expect(second.nextCursor).toBeNull();
  });

  it("lets only one of two concurrent versions win the decision", async () => {
    const { store } = await localStore();
    await store.runs.create(run("run_race"));
    const queued = await store.approvals.enqueue({
      approvalId: "apr_race",
      workspaceId: "default",
      runId: "run_race",
      kind: "gate_failure",
      expiresAt: "2026-11-20T00:00:00.000Z",
    });
    expect(queued.version).toBe(1);

    const first = await store.approvals.decide({
      approvalId: "apr_race",
      expectedVersion: 1,
      status: "approved",
      decisionBy: "operator:a",
      decisionReason: "looks good",
    });
    expect(first.ok).toBe(true);

    const second = await store.approvals.decide({
      approvalId: "apr_race",
      expectedVersion: 1,
      status: "rejected",
      decisionBy: "operator:b",
      decisionReason: "too late",
    });
    expect(second).toMatchObject({
      ok: false,
      code: "version_conflict",
      current: { status: "approved", version: 2, decisionBy: "operator:a" },
    });

    const third = await store.approvals.decide({
      approvalId: "apr_race",
      expectedVersion: 2,
      status: "rejected",
      decisionBy: "operator:b",
      decisionReason: "still no",
    });
    expect(third).toMatchObject({ ok: false, code: "not_pending" });

    const missing = await store.approvals.decide({
      approvalId: "apr_missing",
      expectedVersion: 1,
      status: "approved",
      decisionBy: "operator:a",
      decisionReason: "n/a",
    });
    expect(missing).toEqual({ ok: false, code: "not_found", current: null });
  });

  it("assigns an owner with CAS and blocks stale decisions", async () => {
    const { store } = await localStore();
    await store.runs.create(run("run_take"));
    const queued = await store.approvals.enqueue({
      approvalId: "apr_take",
      workspaceId: "default",
      runId: "run_take",
      kind: "gate_failure",
      expiresAt: "2026-11-20T00:00:00.000Z",
    });
    expect(queued.assignee).toBeNull();

    const taken = await store.approvals.assign({
      approvalId: "apr_take",
      expectedVersion: 1,
      assignee: "operator:web",
      at: "2026-11-15T01:00:00.000Z",
    });
    expect(taken.ok).toBe(true);
    if (!taken.ok) {
      throw new Error("assign failed");
    }
    expect(taken.record).toMatchObject({
      assignee: "operator:web",
      assignedAt: "2026-11-15T01:00:00.000Z",
      version: 2,
    });

    const repeated = await store.approvals.assign({
      approvalId: "apr_take",
      expectedVersion: 2,
      assignee: "operator:web",
    });
    expect(repeated.ok).toBe(true);
    if (repeated.ok) {
      expect(repeated.record.version).toBe(2);
    }

    const stale = await store.approvals.assign({
      approvalId: "apr_take",
      expectedVersion: 1,
      assignee: "operator:other",
    });
    expect(stale).toMatchObject({
      ok: false,
      code: "version_conflict",
      current: { assignee: "operator:web", version: 2 },
    });

    // The old version can no longer decide: takeover invalidates stale reads.
    const decision = await store.approvals.decide({
      approvalId: "apr_take",
      expectedVersion: 1,
      status: "approved",
      decisionBy: "operator:web",
      decisionReason: "after takeover",
    });
    expect(decision).toMatchObject({ ok: false, code: "version_conflict" });

    const decided = await store.approvals.decide({
      approvalId: "apr_take",
      expectedVersion: 2,
      status: "approved",
      decisionBy: "operator:web",
      decisionReason: "after takeover",
    });
    expect(decided.ok).toBe(true);
    if (decided.ok) {
      expect(decided.record.assignee).toBe("operator:web");
    }

    const missing = await store.approvals.assign({
      approvalId: "apr_take",
      expectedVersion: 3,
      assignee: "operator:web",
    });
    expect(missing).toMatchObject({ ok: false, code: "not_pending" });
  });

  it("expires due approvals once and records an audit event", async () => {
    const { store } = await localStore();
    await store.runs.create(run("run_exp"));
    await store.approvals.enqueue({
      approvalId: "apr_exp",
      workspaceId: "default",
      runId: "run_exp",
      kind: "budget_exceeded",
      expiresAt: "2026-11-15T00:00:00.000Z",
    });
    await store.approvals.enqueue({
      approvalId: "apr_future",
      workspaceId: "default",
      runId: "run_exp",
      kind: "budget_exceeded",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });

    const expired = await store.approvals.expireDue("2026-11-16T00:00:00.000Z");
    expect(expired.map((row) => row.approvalId)).toEqual(["apr_exp"]);
    expect(expired[0]).toMatchObject({
      status: "expired",
      decisionBy: "policy:expiry",
      decisionReason: "approval expired without decision",
      version: 2,
    });

    const again = await store.approvals.expireDue("2026-11-16T00:00:00.000Z");
    expect(again).toEqual([]);

    const future = await store.approvals.get("apr_future");
    expect(future?.status).toBe("queued");

    const audit = await store.sql<Array<{ kind: string; payload: string }>>`
      SELECT kind, payload FROM activity_events
      WHERE kind = 'approval.expired'
    `;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.payload ?? "{}")).toMatchObject({
      approvalId: "apr_exp",
      kind: "budget_exceeded",
    });
  });

  it("re-runs the schema on an existing database without losing rows", async () => {
    const { store, config } = await localStore();
    await store.runs.create(run("run_keep"));
    await store.approvals.enqueue({
      approvalId: "apr_keep",
      workspaceId: "default",
      runId: "run_keep",
      kind: "stage_after",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
    await store.close();

    const reopened = await initStore(config);
    closers.push(() => reopened.close());
    const record = await reopened.approvals.get("apr_keep");
    expect(record?.status).toBe("queued");
    const page = await reopened.approvals.list({ status: "queued" });
    expect(page.items.map((item) => item.approvalId)).toEqual(["apr_keep"]);
  });
});
