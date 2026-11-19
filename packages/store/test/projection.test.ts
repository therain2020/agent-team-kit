import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import {
  type ProjectableActivityEvent,
  backfillRunProjections,
  listAgentStates,
  loadRunProjections,
  projectActivityEvent,
} from "../src/projection";
import { initStore } from "../src/store";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-projection-"));
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

type Store = Awaited<ReturnType<typeof sqliteStore>>;

const AT = "2026-11-19T10:00:00.000Z";

async function insertRun(
  store: Store,
  runId: string,
  options: { status?: string; updatedAt?: string } = {},
): Promise<void> {
  const at = options.updatedAt ?? AT;
  await store.sql`
    INSERT INTO runs (
      run_id, event_id, workspace_id, workflow_id, workflow_version,
      run_mode, status, created_at, updated_at
    ) VALUES (
      ${runId}, ${`evt_${runId}`}, ${"default"}, ${"workflow"}, ${"1.0.0"},
      ${"DRY_RUN"}, ${options.status ?? "running"}, ${at}, ${at}
    )
  `;
}

async function insertStage(
  store: Store,
  runId: string,
  stage: string,
  status: string,
  startedAt: string | null = null,
): Promise<void> {
  await store.sql`
    INSERT INTO stages (stage_id, run_id, name, status, started_at)
    VALUES (${`${runId}:${stage}`}, ${runId}, ${stage}, ${status}, ${startedAt})
  `;
}

async function insertActivity(
  store: Store,
  input: {
    runId: string;
    agentId?: string;
    kind: string;
    status?: string;
    tool?: string;
    summary?: string;
    at: string;
  },
): Promise<void> {
  await store.sql`
    INSERT INTO activity_events (
      workspace_id, run_id, agent_id, kind, status, tool, summary, created_at
    ) VALUES (
      ${"default"}, ${input.runId}, ${input.agentId ?? null}, ${input.kind},
      ${input.status ?? null}, ${input.tool ?? null},
      ${input.summary ?? null}, ${input.at}
    )
  `;
}

async function insertCharge(
  store: Store,
  runId: string,
  cnyMicro: number,
  tokens: number,
): Promise<void> {
  const id = `charge_${runId}_${cnyMicro}`;
  await store.sql`
    INSERT INTO budget_charges (
      charge_id, reservation_id, workspace_id, run_id, purpose,
      cost_cny_micro, tokens, created_at
    ) VALUES (
      ${id}, ${`rsv_${id}`}, ${"default"}, ${runId}, ${"model"},
      ${cnyMicro}, ${tokens}, ${AT}
    )
  `;
}

async function insertArtifact(store: Store, runId: string): Promise<void> {
  await store.sql`
    INSERT INTO blobs (blob_id, workspace_id, sha256, size, storage_key, created_at)
    VALUES (${`blob_${runId}`}, ${"default"}, ${`sha_${runId}`}, ${4}, ${`key_${runId}`}, ${AT})
  `;
  await store.sql`
    INSERT INTO manifests (
      manifest_id, workspace_id, producer, input_refs, run_id, stage_id,
      run_mode, cost, sensitivity, retention_class, created_at
    ) VALUES (
      ${`man_${runId}`}, ${"default"}, ${"{}"}, ${"[]"}, ${runId},
      ${`${runId}:stage`}, ${"DRY_RUN"},
      ${'{"currency":"CNY","amount":0.25,"tokens":25}'}, ${"internal"},
      ${"artifact_365d"}, ${AT}
    )
  `;
  await store.sql`
    INSERT INTO artifacts (
      artifact_id, version, workspace_id, blob_id, manifest_id, status, created_at
    ) VALUES (
      ${`art_${runId}`}, ${1}, ${"default"}, ${`blob_${runId}`},
      ${`man_${runId}`}, ${"committed"}, ${AT}
    )
  `;
}

function event(
  overrides: Partial<ProjectableActivityEvent> & { eventId: number },
): ProjectableActivityEvent {
  return {
    workspaceId: "default",
    runId: "run_1",
    kind: "stage.started",
    status: "running",
    createdAt: AT,
    ...overrides,
  };
}

describe("run world projection (sqlite)", () => {
  it("materializes run state from an event", async () => {
    const store = await sqliteStore();
    await insertRun(store, "run_1");
    await insertStage(store, "run_1", "collect", "succeeded", AT);
    await insertStage(store, "run_1", "write", "running", AT);
    await insertCharge(store, "run_1", 500_000, 50);
    await insertArtifact(store, "run_1");

    await projectActivityEvent(
      store.sql,
      event({
        eventId: 1,
        stageId: "run_1:write",
        agentId: "writer",
        summary: "write",
      }),
    );

    const [row] = await loadRunProjections(store.sql, {
      workspaceId: "default",
    });
    expect(row).toMatchObject({
      runId: "run_1",
      workspaceId: "default",
      status: "running",
      currentStage: "run_1:write",
      progress: 0.5,
      costCny: 0.5,
      tokens: 50,
      artifactCount: 1,
      waitReason: null,
      lastEventId: 1,
      version: 1,
    });

    await store.sql`
      UPDATE stages SET status = 'succeeded' WHERE stage_id = ${"run_1:write"}
    `;
    await projectActivityEvent(
      store.sql,
      event({ eventId: 2, kind: "run.finished", status: "succeeded" }),
    );
    const [finished] = await loadRunProjections(store.sql, {
      workspaceId: "default",
    });
    expect(finished?.status).toBe("succeeded");
    expect(finished?.progress).toBe(1);
  });

  it("is idempotent when the same event is applied twice", async () => {
    const store = await sqliteStore();
    await insertRun(store, "run_1");
    const input = event({ eventId: 7, summary: "collect" });

    const first = await projectActivityEvent(store.sql, input);
    const second = await projectActivityEvent(store.sql, input);

    expect(second).toMatchObject({
      status: "running",
      lastEventId: 7,
      currentStage: null,
    });
    expect(second?.version).toBe((first?.version ?? 0) + 1);

    const rows = await store.sql<Array<{ count: number }>>`
      SELECT COUNT(*) AS count FROM run_projection
    `;
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("ignores stale events so out-of-order delivery converges", async () => {
    const store = await sqliteStore();
    await insertRun(store, "run_1");

    await projectActivityEvent(
      store.sql,
      event({
        eventId: 10,
        kind: "budget.exceeded",
        status: "paused",
        summary: "budget",
      }),
    );
    const afterStale = await projectActivityEvent(
      store.sql,
      event({ eventId: 5, kind: "run.started", status: "running" }),
    );
    expect(afterStale).toMatchObject({
      status: "paused",
      waitReason: "budget",
      lastEventId: 10,
    });

    await store.sql`DELETE FROM run_projection`;
    await projectActivityEvent(
      store.sql,
      event({ eventId: 10, kind: "run.started", status: "running" }),
    );
    const reversed = await projectActivityEvent(
      store.sql,
      event({
        eventId: 5,
        kind: "budget.exceeded",
        status: "paused",
        summary: "budget",
      }),
    );
    expect(reversed).toMatchObject({
      status: "running",
      waitReason: null,
      lastEventId: 10,
    });
  });

  it("derives agent state from the latest activity event", async () => {
    const store = await sqliteStore();
    await insertActivity(store, {
      runId: "run_1",
      agentId: "writer",
      kind: "tool.call",
      status: "running",
      tool: "repo_read",
      at: "2026-11-19T10:00:00.000Z",
    });
    await insertActivity(store, {
      runId: "run_1",
      agentId: "writer",
      kind: "tool.result",
      status: "completed",
      tool: "repo_read",
      at: "2026-11-19T10:01:00.000Z",
    });
    await insertActivity(store, {
      runId: "run_2",
      agentId: "critic",
      kind: "model.turn",
      status: "running",
      at: "2026-11-19T10:02:00.000Z",
    });

    const states = await listAgentStates(store.sql, {
      workspaceId: "default",
    });
    expect(states).toHaveLength(2);
    expect(states.find((state) => state.agentId === "writer")).toMatchObject({
      state: "completed",
      runId: "run_1",
      currentTool: "repo_read",
      since: "2026-11-19T10:01:00.000Z",
    });
    expect(states.find((state) => state.agentId === "critic")).toMatchObject({
      state: "running",
      currentTool: null,
    });
  });

  it("backfills existing runs and converges on re-run", async () => {
    const store = await sqliteStore();
    await insertRun(store, "run_1", { status: "paused" });
    await insertStage(store, "run_1", "collect", "succeeded", AT);
    await insertStage(store, "run_1", "write", "running", AT);
    await insertCharge(store, "run_1", 250_000, 25);
    await insertArtifact(store, "run_1");
    await insertActivity(store, {
      runId: "run_1",
      kind: "budget.exceeded",
      status: "paused",
      summary: "budget exhausted",
      at: AT,
    });

    const first = await backfillRunProjections(store);
    expect(first.runs).toBe(1);
    const [initial] = await loadRunProjections(store.sql, {
      workspaceId: "default",
    });
    expect(initial).toMatchObject({
      runId: "run_1",
      status: "paused",
      currentStage: "run_1:write",
      progress: 0.5,
      costCny: 0.25,
      tokens: 25,
      artifactCount: 1,
      waitReason: "budget exhausted",
    });
    expect(initial?.lastEventId).toBeGreaterThan(0);

    await backfillRunProjections(store);
    const rows = await loadRunProjections(store.sql, {
      workspaceId: "default",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: initial?.runId,
      status: initial?.status,
      progress: initial?.progress,
      costCny: initial?.costCny,
      tokens: initial?.tokens,
      artifactCount: initial?.artifactCount,
      waitReason: initial?.waitReason,
      lastEventId: initial?.lastEventId,
    });
    expect(rows[0]?.version).toBe((initial?.version ?? 0) + 1);
  });

  it("paginates and filters by cursor", async () => {
    const store = await sqliteStore();
    for (const runId of ["run_1", "run_2", "run_3"]) {
      await insertRun(store, runId);
    }
    const ids: number[] = [];
    for (const [index, runId] of ["run_1", "run_2", "run_3"].entries()) {
      const eventId = index + 1;
      ids.push(eventId);
      await projectActivityEvent(
        store.sql,
        event({
          eventId,
          runId,
          kind: "run.started",
          status: "running",
          createdAt: `2026-11-19T10:0${index}:00.000Z`,
        }),
      );
    }

    const page = await loadRunProjections(store.sql, {
      workspaceId: "default",
      limit: 2,
    });
    expect(page).toHaveLength(2);
    expect(page[0]?.runId).toBe("run_3");

    const incremental = await loadRunProjections(store.sql, {
      workspaceId: "default",
      since: ids[1],
    });
    expect(incremental.map((row) => row.runId)).toEqual(["run_3"]);
  });
});
