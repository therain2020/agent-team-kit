import { mkdtemp, rm } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { appendActivity, listActivity } from "@kit/activity";
import { loadWorldSnapshot } from "@kit/store";
import { initStore, loadStoreConfig } from "@kit/store";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { decideApprovalEntity } from "../src/agent-approvals";
import { reconnectDelay, streamWorldDeltas } from "../src/agent-watch";
import { registerAgent } from "../src/commands/agent";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function sqliteStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-agent-cli-"));
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

function leafCommands(command: Command): Command[] {
  if (command.commands.length === 0) {
    return command.name() ? [command] : [];
  }
  return command.commands.flatMap((child) => leafCommands(child));
}

function findCommand(root: Command, ...names: string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const name of names) {
    current = current.commands.find((child) => child.name() === name);
    if (!current) {
      return undefined;
    }
  }
  return current;
}

describe("kit agent world", () => {
  it("serves the same snapshot contract as /api/world", async () => {
    const store = await sqliteStore();
    await appendActivity(store, {
      runId: "run_1",
      agentId: "writer",
      kind: "stage.started",
      status: "running",
      summary: "collect",
    });
    const lastEvent = await appendActivity(store, {
      runId: "run_2",
      agentId: "critic",
      kind: "run.started",
      status: "running",
    });

    const world = await loadWorldSnapshot(store);

    // Shape is the shared `WorldSnapshotResult` type: { snapshot, seq, etag }.
    expect(Object.keys(world).sort()).toEqual(["etag", "seq", "snapshot"]);
    expect(world.seq).toBe(lastEvent);
    expect(world.etag).toBe(`W/"world-${lastEvent}"`);
    expect(Object.keys(world.snapshot).sort()).toEqual([
      "agents",
      "computedAt",
      "runs",
    ]);
    expect(world.snapshot.runs.map((run) => run.runId).sort()).toEqual([
      "run_1",
      "run_2",
    ]);
    expect(
      world.snapshot.agents.find((agent) => agent.agentId === "writer"),
    ).toMatchObject({ state: "running", runId: "run_1" });

    // `since` narrows to runs touched after the cursor, matching /api/world.
    await appendActivity(store, {
      runId: "run_2",
      kind: "run.finished",
      status: "succeeded",
    });
    const incremental = await loadWorldSnapshot(store, { since: lastEvent });
    expect(incremental.snapshot.runs.map((run) => run.runId)).toEqual([
      "run_2",
    ]);
    expect(incremental.seq).toBeGreaterThan(lastEvent);
  });
});

describe("kit agent approvals decide", () => {
  async function seedApproval(
    store: Awaited<ReturnType<typeof sqliteStore>>,
    approvalId = "approval_1",
  ) {
    await store.approvals.enqueue({
      approvalId,
      workspaceId: "default",
      runId: "run_1",
      kind: "stage_before",
    });
    return approvalId;
  }

  it("decides with CAS and emits an approval.decided activity event", async () => {
    const store = await sqliteStore();
    const approvalId = await seedApproval(store);

    const result = await decideApprovalEntity(store, {
      approvalId,
      status: "approved",
      decisionBy: "operator:cli:agent",
      reason: "looks good",
      expectedVersion: 1,
    });

    expect(result).toMatchObject({
      approvalId,
      status: "approved",
      version: 2,
      duplicate: false,
    });
    expect(typeof result.eventId).toBe("number");

    const events = await listActivity(store, {
      runId: "run_1",
      kind: "approval.decided",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("approved");
    expect(events[0]?.payload).toMatchObject({ approvalId, version: 2 });
  });

  it("replays an idempotency-keyed decision instead of racing it", async () => {
    const store = await sqliteStore();
    const approvalId = await seedApproval(store);

    const first = await decideApprovalEntity(store, {
      approvalId,
      status: "rejected",
      decisionBy: "operator:cli:agent",
      reason: "no budget",
      idempotencyKey: "key-1",
    });
    expect(first).toMatchObject({ status: "rejected", duplicate: false });

    const replay = await decideApprovalEntity(store, {
      approvalId,
      status: "rejected",
      decisionBy: "operator:cli:agent",
      reason: "no budget",
      idempotencyKey: "key-1",
    });
    expect(replay).toMatchObject({
      status: "rejected",
      version: first.version,
      duplicate: true,
    });
    expect(replay.eventId).toBeUndefined();

    // The replay must not append a second activity event.
    const events = await listActivity(store, {
      runId: "run_1",
      kind: "approval.decided",
    });
    expect(events).toHaveLength(1);
  });

  it("returns conflict on a stale version", async () => {
    const store = await sqliteStore();
    const approvalId = await seedApproval(store);
    await decideApprovalEntity(store, {
      approvalId,
      status: "approved",
      decisionBy: "operator:cli:agent",
      reason: "ok",
    });

    // The row is now version 2; deciding against version 1 is stale.
    await expect(
      decideApprovalEntity(store, {
        approvalId,
        status: "approved",
        decisionBy: "operator:cli:agent",
        reason: "ok",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("returns conflict when the approval already left queued", async () => {
    const store = await sqliteStore();
    const approvalId = await seedApproval(store);
    await decideApprovalEntity(store, {
      approvalId,
      status: "approved",
      decisionBy: "operator:cli:agent",
      reason: "ok",
    });

    await expect(
      decideApprovalEntity(store, {
        approvalId,
        status: "rejected",
        decisionBy: "operator:cli:agent",
        reason: "changed my mind",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("returns not_found for an unknown approval", async () => {
    const store = await sqliteStore();
    await expect(
      decideApprovalEntity(store, {
        approvalId: "missing",
        status: "approved",
        decisionBy: "operator:cli:agent",
        reason: "ok",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

interface MockStream {
  baseUrl: string;
  requests: Array<{ after: number; lastEventId: string | null }>;
}

async function startWorldStream(
  framesFor: (after: number) => number[],
): Promise<MockStream> {
  const requests: MockStream["requests"] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const after = Number(url.searchParams.get("after") ?? 0);
    requests.push({
      after,
      lastEventId: req.headers["last-event-id"]?.toString() ?? null,
    });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.write("retry: 2000\n\n");
    for (const seq of framesFor(after)) {
      res.write(
        `id: ${seq}\nevent: world\ndata: ${JSON.stringify({
          seq,
          runs: [],
          agents: [],
          eventCount: 1,
        })}\n\n`,
      );
    }
    // Close after each batch so the client exercises reconnect + resume.
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

describe("kit agent watch (SSE)", () => {
  it("prints one delta and stops with --once", async () => {
    const mock = await startWorldStream(() => [7]);
    const deltas: unknown[] = [];

    const result = await streamWorldDeltas({
      baseUrl: mock.baseUrl,
      after: 6,
      maxEvents: 1,
      maxReconnects: 2,
      sleep: async () => undefined,
      onDelta: (delta) => {
        deltas.push(delta);
      },
    });

    expect(result).toEqual({ cursor: 7, events: 1 });
    expect(deltas).toHaveLength(1);
    expect(mock.requests[0]).toEqual({ after: 6, lastEventId: "6" });
  });

  it("resumes from the last seq after a disconnect without loss or duplicates", async () => {
    // First connection (after=5) yields seq 6 then EOF; the retry must ask for
    // after=6 and continue from seq 7.
    const mock = await startWorldStream((after) =>
      after <= 5 ? [6] : after === 6 ? [7] : [],
    );
    const seqs: number[] = [];

    const result = await streamWorldDeltas({
      baseUrl: mock.baseUrl,
      after: 5,
      maxEvents: 2,
      maxReconnects: 3,
      sleep: async () => undefined,
      reconnectBaseMs: 1,
      onDelta: (delta) => {
        seqs.push((delta as { seq: number }).seq);
      },
    });

    expect(seqs).toEqual([6, 7]);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(result).toEqual({ cursor: 7, events: 2 });
    expect(mock.requests.map((request) => request.after)).toEqual([5, 6]);
  });

  it("caps reconnect backoff", () => {
    expect(reconnectDelay(1, 1000, 30_000)).toBe(1000);
    expect(reconnectDelay(2, 1000, 30_000)).toBe(2000);
    expect(reconnectDelay(10, 1000, 30_000)).toBe(30_000);
  });
});

describe("kit agent registry", () => {
  it("exposes agent leaves that accept --json", () => {
    const program = new Command();
    registerAgent(program);

    for (const path of [
      ["agent", "world"],
      ["agent", "watch"],
      ["agent", "approvals", "decide"],
    ]) {
      const command = findCommand(program, ...path);
      expect(command, `kit ${path.join(" ")} is not registered`).toBeDefined();
      expect(
        command?.options.some((option) => option.long === "--json"),
        `kit ${path.join(" ")} is missing --json`,
      ).toBe(true);
    }

    const approveHelp = findCommand(program, "agent", "approvals") as
      | Command
      | undefined;
    expect(approveHelp?.options.some((o) => o.long === "--json")).toBe(true);

    const decide = findCommand(program, "agent", "approvals", "decide");
    expect(
      decide?.options.some((option) => option.long === "--idempotency-key"),
    ).toBe(true);

    // The group itself is not a leaf; only real leaves are enumerated.
    expect(leafCommands(program).map((command) => command.name())).toContain(
      "world",
    );
  });
});
