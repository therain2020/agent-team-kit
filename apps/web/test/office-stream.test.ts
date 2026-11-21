import { readFileSync } from "node:fs";
import type { AgentState, RunProjection } from "@kit/store";
import { describe, expect, it } from "vitest";
import { deriveLiveAgents } from "../lib/office-live";
import {
  applyWorldDelta,
  applyWorldSnapshot,
  initialWorldState,
} from "../lib/world-state";

function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/** Every module the world stream feeds on the office and factory surfaces. */
const STREAM_FILES = [
  "../lib/world-client.ts",
  "../components/office/office-scene.tsx",
  "../components/office/factory-floor.tsx",
  "../components/pixel/pixel-world.tsx",
];

function run(
  overrides: Partial<RunProjection> & { runId: string },
): RunProjection {
  return {
    workspaceId: "default",
    workflowId: "flow",
    status: "running",
    currentStage: "plan:write",
    progress: 0.5,
    costCny: 0.1,
    tokens: 100,
    artifactCount: 0,
    waitReason: null,
    lastEventId: 10,
    version: 1,
    updatedAt: "2026-11-21T10:00:00.000Z",
    ...overrides,
  };
}

function agent(
  overrides: Partial<AgentState> & { agentId: string },
): AgentState {
  return {
    state: "running",
    since: "2026-11-21T10:00:00.000Z",
    runId: "run_1",
    currentTool: null,
    ...overrides,
  };
}

const baseAgent = {
  id: "builder",
  isManager: false,
  description: "builds",
  model: "deepseek",
  role: "builder" as const,
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
  phase: "build" as const,
  createdAt: "2026-11-21T09:00:00.000Z",
  costCny: 0,
  goal: "Build it",
  manager: "manager",
  sellers: [],
  builders: ["builder"],
  specialists: [],
  agents: ["builder"],
};

describe("world stream updates without a full-page reload (97 §3.2)", () => {
  it("folds a stream delta into the live office projection in place", () => {
    const loaded = applyWorldSnapshot(
      initialWorldState,
      {
        snapshot: {
          runs: [run({ runId: "run_1", progress: 0.5 })],
          agents: [agent({ agentId: "builder" })],
          computedAt: "2026-11-21T10:00:00.000Z",
        },
        seq: 10,
        etag: 'W/"world-10"',
      },
      1_000,
    );
    const next = applyWorldDelta(
      loaded,
      {
        seq: 11,
        runs: [
          run({
            runId: "run_1",
            progress: 0.9,
            currentStage: "review:gate",
            lastEventId: 11,
          }),
        ],
        agents: [
          agent({
            agentId: "builder",
            state: "running",
            since: "2026-11-21T10:00:05.000Z",
          }),
        ],
        eventCount: 1,
      },
      2_000,
    );

    // The delta is applied to the shared store; the floor re-derives from it.
    expect(next.seq).toBe(11);
    const agents = deriveLiveAgents([baseAgent], next.world, [baseMission]);
    expect(agents[0]).toMatchObject({
      status: "working",
      live: true,
      progress: 0.9,
      activityDetail: "review:gate",
    });
  });

  it("feeds the store, never the navigation APIs", () => {
    const client = readSource("../lib/world-client.ts");
    expect(client).toContain("enqueueDelta(delta, gen)");
    expect(client).toContain("applyWorldDelta(state, merged)");

    for (const file of STREAM_FILES) {
      const source = readSource(file);
      expect(source).not.toMatch(/location\.(?:reload|assign|replace)\s*\(/);
      expect(source).not.toMatch(/window\.location\s*=/);
      expect(source).not.toMatch(/\.reload\s*\(/);
    }
  });

  it("adds an unknown run from the office snapshot into state, not a route", () => {
    const scene = readSource("../components/office/office-scene.tsx");
    expect(scene).toContain("/api/office?pack=");
    expect(scene).toContain("setActiveSnapshot(payload.active)");
    expect(scene).toContain("setLinkSnapshot(payload.factoryLink)");
    expect(scene).not.toMatch(/location\.reload/);
  });
});
