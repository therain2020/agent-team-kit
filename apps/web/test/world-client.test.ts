import type { AgentState, RunProjection } from "@kit/store";
import { describe, expect, it } from "vitest";
import type { FactoryItem } from "../lib/factory";
import { deriveLiveAgents, deriveLiveMissions } from "../lib/office-live";
import {
  WORLD_EVENT_QUEUE_LIMIT,
  type WorldClientState,
  type WorldDelta,
  applyWorldDelta,
  applyWorldSnapshot,
  initialWorldState,
  managerPresence,
  mergeAgents,
  mergeDeltas,
  mergeRuns,
  presenceFromAgentState,
  presenceStatus,
  pushWorldDelta,
  reconcileFactoryItems,
  reconnectDelay,
} from "../lib/world-state";

function run(
  overrides: Partial<RunProjection> & { runId: string },
): RunProjection {
  return {
    workspaceId: "default",
    status: "running",
    currentStage: "plan:write",
    progress: 0.5,
    costCny: 0.1,
    tokens: 100,
    artifactCount: 1,
    waitReason: null,
    lastEventId: 10,
    version: 1,
    updatedAt: "2026-11-19T10:00:00.000Z",
    ...overrides,
  };
}

function agent(
  overrides: Partial<AgentState> & { agentId: string },
): AgentState {
  return {
    state: "running",
    since: "2026-11-19T10:00:00.000Z",
    runId: "run_1",
    currentTool: null,
    ...overrides,
  };
}

function loaded(runs: RunProjection[], agents: AgentState[]): WorldClientState {
  return applyWorldSnapshot(
    initialWorldState,
    {
      snapshot: {
        runs,
        agents,
        computedAt: "2026-11-19T10:00:00.000Z",
      },
      seq: 10,
      etag: 'W/"world-10"',
    },
    1_000,
  );
}

describe("world client reducer", () => {
  it("applies a snapshot and then folds deltas by key", () => {
    const state = loaded(
      [run({ runId: "run_1" }), run({ runId: "run_2", lastEventId: 8 })],
      [agent({ agentId: "seller" })],
    );
    expect(state.world?.runs).toHaveLength(2);
    expect(state.seq).toBe(10);
    expect(state.lastUpdatedAt).toBe(1_000);

    const next = applyWorldDelta(
      state,
      {
        seq: 12,
        runs: [run({ runId: "run_1", status: "paused", lastEventId: 12 })],
        agents: [
          agent({
            agentId: "seller",
            state: "pending",
            since: "2026-11-19T10:00:02.000Z",
          }),
        ],
        eventCount: 2,
      },
      2_000,
    );

    expect(next.seq).toBe(12);
    expect(next.lastUpdatedAt).toBe(2_000);
    expect(
      next.world?.runs.find((entry) => entry.runId === "run_1")?.status,
    ).toBe("paused");
    expect(next.world?.agents[0]).toMatchObject({
      agentId: "seller",
      state: "pending",
    });
  });

  it("never regresses a newer row and stays idempotent", () => {
    const state = loaded(
      [run({ runId: "run_1", lastEventId: 20, status: "succeeded" })],
      [agent({ agentId: "seller", since: "2026-11-19T10:00:05.000Z" })],
    );
    const delta = {
      seq: 21,
      runs: [run({ runId: "run_1", lastEventId: 18, status: "running" })],
      agents: [
        agent({
          agentId: "seller",
          state: "paused",
          since: "2026-11-19T09:00:00.000Z",
        }),
      ],
      eventCount: 1,
    };

    const once = applyWorldDelta(state, delta, 3_000);
    const twice = applyWorldDelta(once, delta, 4_000);

    expect(once.world?.runs[0]?.status).toBe("succeeded");
    expect(once.world?.agents[0]?.state).toBe("running");
    expect(twice.world?.runs).toEqual(once.world?.runs);
    expect(twice.world?.agents).toEqual(once.world?.agents);
  });

  it("keeps the newest projection row for the same key", () => {
    const merged = mergeRuns(
      [run({ runId: "run_1", lastEventId: 5 })],
      [run({ runId: "run_1", lastEventId: 5, version: 2, status: "paused" })],
    );
    expect(merged[0]?.version).toBe(2);
    expect(merged[0]?.status).toBe("paused");

    const agents = mergeAgents(
      [agent({ agentId: "seller", since: "2026-11-19T10:00:00.000Z" })],
      [
        agent({
          agentId: "seller",
          since: "2026-11-19T09:59:00.000Z",
          state: "idle",
        }),
      ],
    );
    expect(agents[0]?.state).toBe("running");
  });

  it("maps projection states onto the four floor states", () => {
    expect(presenceStatus("running")).toBe("working");
    expect(presenceStatus("stage.started")).toBe("working");
    expect(presenceStatus("tool.call")).toBe("working");
    expect(presenceStatus("coder.edit")).toBe("working");
    expect(presenceStatus("pending")).toBe("waiting-approval");
    expect(presenceStatus("approval.requested")).toBe("waiting-approval");
    expect(presenceStatus("paused")).toBe("blocked");
    expect(presenceStatus("failed")).toBe("error");
    expect(presenceStatus("succeeded")).toBe("idle");
    expect(presenceStatus("").length).toBeGreaterThan(0);

    const presence = presenceFromAgentState(
      agent({ agentId: "seller", currentTool: "repo_read" }),
    );
    expect(presence).toMatchObject({
      status: "working",
      currentTool: "repo_read",
      runId: "run_1",
    });
    expect(presenceFromAgentState(undefined)).toBeNull();
  });

  it("derives manager presence from paused before running runs", () => {
    const state = loaded(
      [
        run({ runId: "run_1", status: "running" }),
        run({
          runId: "run_2",
          status: "paused",
          updatedAt: "2026-11-19T11:00:00.000Z",
        }),
        run({ runId: "other", status: "paused" }),
      ],
      [],
    );
    const scoped = new Set(["run_1", "run_2"]);
    expect(managerPresence(state.world, scoped)).toMatchObject({
      status: "waiting-approval",
      runId: "run_2",
    });
    expect(managerPresence(state.world, new Set(["run_1"]))).toMatchObject({
      status: "working",
      runId: "run_1",
    });
    expect(managerPresence(null, scoped)).toBeNull();
  });
});

describe("office live projection", () => {
  const baseAgent = {
    id: "seller",
    isManager: false,
    description: "sells",
    model: "deepseek",
    role: "seller" as const,
    tools: [],
    skills: [],
    status: "idle" as const,
    activity: "Waiting for a mission",
    activityKind: "waitingMission" as const,
  };
  const baseMission = {
    runId: "run_1",
    workflowId: "flow",
    status: "running",
    phase: "demand" as const,
    createdAt: "2026-11-19T09:00:00.000Z",
    costCny: 0,
    goal: "Build it",
    manager: "manager",
    sellers: ["seller"],
    builders: [],
    specialists: [],
    agents: ["seller"],
  };

  it("overlays status, since, stage and progress from the world", () => {
    const state = loaded(
      [run({ runId: "run_1", progress: 0.75 })],
      [
        agent({
          agentId: "seller",
          state: "running",
          since: "2026-11-19T10:30:00.000Z",
        }),
      ],
    );
    const agents = deriveLiveAgents([baseAgent], state.world, [baseMission]);
    expect(agents[0]).toMatchObject({
      status: "working",
      live: true,
      since: "2026-11-19T10:30:00.000Z",
      progress: 0.75,
      activityKind: "liveStage",
      activityDetail: "plan:write",
    });

    const missions = deriveLiveMissions([baseMission], state.world);
    expect(missions[0]).toMatchObject({
      progress: 0.75,
      currentStage: "plan:write",
      live: true,
      optimistic: false,
    });

    // A paused mission that resumed moves out of the blocked lane.
    const resumed = deriveLiveMissions(
      [{ ...baseMission, phase: "blocked", status: "paused" }],
      state.world,
    );
    expect(resumed[0]).toMatchObject({ phase: "build", status: "running" });
  });

  it("ignores agent state from another Pack's run", () => {
    const state = loaded(
      [run({ runId: "run_1" })],
      [
        agent({
          agentId: "seller",
          runId: "run_other",
          state: "running",
          since: "2026-11-19T11:00:00.000Z",
        }),
      ],
    );
    const agents = deriveLiveAgents([baseAgent], state.world, [baseMission]);
    expect(agents[0]).toMatchObject({ status: "idle", live: false });
  });

  it("keeps an optimistic mission until the stream knows the run", () => {
    const optimistic = {
      runId: "run_new",
      workflowId: "flow",
      goal: "New goal",
      createdAt: "2026-11-19T10:00:00.000Z",
      manager: "manager",
      sellers: ["seller"],
      builders: [],
      specialists: [],
      agents: ["seller"],
    };
    const drawn = deriveLiveMissions([], null, [optimistic]);
    expect(drawn[0]).toMatchObject({ optimistic: true, status: "pending" });

    const agents = deriveLiveAgents([baseAgent], null, [], [optimistic]);
    expect(agents[0]).toMatchObject({
      status: "working",
      live: true,
      runId: "run_new",
    });

    const acknowledged = loaded([run({ runId: "run_new" })], []);
    expect(
      deriveLiveMissions([], acknowledged.world, [optimistic]),
    ).toHaveLength(1);
    expect(
      deriveLiveMissions(
        [{ ...baseMission, runId: "run_new" }],
        acknowledged.world,
        [optimistic],
      ),
    ).toHaveLength(1);
  });
});

describe("factory reconciliation", () => {
  const approval = (runId: string): FactoryItem => ({
    kind: "approval",
    requestId: `req-${runId}`,
    runId,
    riskClass: "low",
    summary: "gate",
    costCny: 0,
    updatedAt: "2026-11-19T09:00:00.000Z",
    artifactCount: 0,
  });

  it("removes approvals whose run is no longer paused", () => {
    const state = loaded(
      [
        run({ runId: "run_resumed", status: "running" }),
        run({ runId: "run_paused", status: "paused" }),
      ],
      [],
    );
    const items = [approval("run_resumed"), approval("run_paused")];
    const next = reconcileFactoryItems(items, state.world);
    expect(next.map((item) => item.runId)).toEqual(["run_paused"]);
  });

  it("keeps items whose run is not in the projection and is stable", () => {
    const state = loaded([run({ runId: "run_x" })], []);
    const items = [approval("run_unknown")];
    expect(reconcileFactoryItems(items, state.world)).toBe(items);
    expect(reconcileFactoryItems(items, null)).toBe(items);
  });
});

describe("reconnect backoff", () => {
  it("grows exponentially and is capped", () => {
    const fixed = () => 0.5;
    expect(reconnectDelay(0, fixed)).toBe(1_000);
    expect(reconnectDelay(1, fixed)).toBe(2_000);
    expect(reconnectDelay(2, fixed)).toBe(4_000);
    expect(reconnectDelay(9, fixed)).toBe(30_000);
    expect(reconnectDelay(-1, fixed)).toBe(1_000);
  });
});

describe("world stream batching and fallback", () => {
  function delta(
    seq: number,
    runs: RunProjection[] = [],
    agents: AgentState[] = [],
    eventCount = 1,
  ): WorldDelta {
    return { seq, runs, agents, eventCount };
  }

  it("drops deltas at or behind the applied cursor", () => {
    const state = loaded([run({ runId: "run_1" })], []);
    const paused = run({ runId: "run_1", status: "paused", lastEventId: 10 });
    const stale = applyWorldDelta(state, delta(10, [paused]), 2_000);
    expect(stale).toBe(state);
    const failed = run({ runId: "run_1", status: "failed", lastEventId: 9 });
    const older = applyWorldDelta(state, delta(9, [failed]), 2_000);
    expect(older).toBe(state);
  });

  it("coalesces a batch by key and keeps the highest seq", () => {
    const merged = mergeDeltas([
      delta(11, [run({ runId: "run_1", lastEventId: 11 })], [], 2),
      delta(
        13,
        [run({ runId: "run_2", lastEventId: 13 })],
        [agent({ agentId: "builder" })],
        3,
      ),
    ]);
    expect(merged.seq).toBe(13);
    expect(merged.eventCount).toBe(5);
    expect(merged.runs.map((entry) => entry.runId).sort()).toEqual([
      "run_1",
      "run_2",
    ]);
    expect(merged.agents).toHaveLength(1);
  });

  it("caps the queue at 500 events and reports the drop", () => {
    const perFrame = WORLD_EVENT_QUEUE_LIMIT / 5;
    let queue: WorldDelta[] = [];
    let dropped = 0;
    for (let index = 1; index <= 10; index += 1) {
      const pushed = pushWorldDelta(queue, delta(index, [], [], perFrame));
      queue = pushed.queue;
      dropped += pushed.dropped;
    }
    expect(queue).toHaveLength(5);
    expect(dropped).toBe(WORLD_EVENT_QUEUE_LIMIT);
    expect(queue.at(-1)?.seq).toBe(10);
  });

  it("clears degradation on a snapshot and keeps polling status", () => {
    const polling: WorldClientState = {
      ...initialWorldState,
      status: "polling",
      degraded: true,
      seq: 5,
    };
    const next = applyWorldSnapshot(
      polling,
      {
        snapshot: {
          runs: [],
          agents: [],
          computedAt: "2026-11-20T00:00:00.000Z",
        },
        seq: 12,
        etag: 'W/"world-12"',
      },
      1_000,
    );
    expect(next.status).toBe("polling");
    expect(next.degraded).toBe(false);
    expect(next.seq).toBe(12);
  });
});
