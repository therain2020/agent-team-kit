import type { AgentState, RunProjection } from "@kit/store";
import { describe, expect, it } from "vitest";
import {
  MAX_BELT_CRATES,
  type WorldCue,
  appendCrate,
  crateLabel,
  crateTone,
  diffWorldCues,
  seedBeltCrates,
} from "../lib/world-cues";
import type { WorldSnapshot } from "../lib/world-state";

function run(partial: Partial<RunProjection> = {}): RunProjection {
  return {
    runId: "run_1",
    workspaceId: "default",
    workflowId: "wf_1",
    status: "running",
    currentStage: "run_1:build",
    progress: 0.2,
    costCny: 1,
    tokens: 100,
    artifactCount: 1,
    waitReason: null,
    lastEventId: 10,
    version: 1,
    updatedAt: "2026-11-19T00:00:00.000Z",
    ...partial,
  };
}

function agent(partial: Partial<AgentState> = {}): AgentState {
  return {
    agentId: "builder",
    state: "working",
    since: "2026-11-19T00:00:00.000Z",
    runId: "run_1",
    currentTool: null,
    ...partial,
  };
}

function world(
  runs: RunProjection[],
  agents: AgentState[] = [],
): WorldSnapshot {
  return { runs, agents, computedAt: "2026-11-19T00:00:00.000Z" };
}

function types(cues: WorldCue[]): string[] {
  return cues.map((cue) => cue.type);
}

describe("world cue derivation", () => {
  it("produces nothing without two snapshots or without change", () => {
    expect(diffWorldCues(null, world([run()]))).toEqual([]);
    const snapshot = world([run()]);
    expect(diffWorldCues(snapshot, snapshot)).toEqual([]);
    expect(diffWorldCues(snapshot, world([run({ lastEventId: 11 })]))).toEqual(
      [],
    );
  });

  it("emits a crate when a run grows its artifact count", () => {
    const cues = diffWorldCues(
      world([run({ artifactCount: 1 })]),
      world([run({ artifactCount: 2, lastEventId: 12 })]),
    );
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({
      type: "crate",
      runId: "run_1",
      label: "build",
      tone: "low",
    });
  });

  it("tones crates by status and keeps labels short", () => {
    expect(crateTone("paused")).toBe("high");
    expect(crateTone("failed")).toBe("bad");
    expect(crateTone("succeeded")).toBe("medium");
    expect(crateLabel(run({ currentStage: "run_1:verify:gate" }))).toBe("gate");
    expect(
      crateLabel(run({ currentStage: null, runId: "run_abcdef123" })),
    ).toBe("def123");
  });

  it("aggregates token/cost growth into one flow cue", () => {
    const cues = diffWorldCues(
      world([
        run({ tokens: 100, costCny: 1 }),
        run({ runId: "run_2", tokens: 50, costCny: 0.5, lastEventId: 4 }),
      ]),
      world([
        run({ tokens: 180, costCny: 1.4, lastEventId: 14 }),
        run({
          runId: "run_2",
          tokens: 90,
          costCny: 0.9,
          lastEventId: 5,
          artifactCount: 2,
        }),
      ]),
    );
    const flow = cues.find((cue) => cue.type === "flow");
    expect(flow).toMatchObject({ type: "flow", tokens: 120 });
    expect(
      Math.round(
        ((flow as { costCny: number }).costCny + Number.EPSILON) * 100,
      ) / 100,
    ).toBe(0.8);
    expect(types(cues)).toContain("crate");
  });

  it("stamps gate crossings and reverses on failure/cancellation", () => {
    const passed = diffWorldCues(
      world([run({ status: "paused" })]),
      world([run({ status: "running", lastEventId: 12 })]),
    );
    expect(passed).toContainEqual({ type: "stamp", outcome: "passed" });

    const failed = diffWorldCues(
      world([run({ status: "running" })]),
      world([run({ status: "failed", lastEventId: 12 })]),
    );
    expect(failed).toContainEqual({ type: "stamp", outcome: "failed" });
    expect(failed).toContainEqual({ type: "reverse", runId: "run_1" });

    const cancelled = diffWorldCues(
      world([run({ status: "queued" })]),
      world([run({ status: "cancelled", lastEventId: 12 })]),
    );
    expect(cancelled).toContainEqual({ type: "reverse", runId: "run_1" });
    expect(cancelled.some((cue) => cue.type === "stamp")).toBe(false);
  });

  it("emits a tool bubble only when the current tool changes", () => {
    const cues = diffWorldCues(
      world([run()], [agent({ currentTool: "read_file" })]),
      world([run()], [agent({ currentTool: "write_file" })]),
    );
    expect(cues).toEqual([
      { type: "tool", agentId: "builder", tool: "write_file" },
    ]);

    expect(
      diffWorldCues(
        world([run()], [agent({ currentTool: "read_file" })]),
        world([run()], [agent({ currentTool: "read_file" })]),
      ),
    ).toEqual([]);
    expect(
      diffWorldCues(
        world([run()], [agent({ currentTool: "read_file" })]),
        world([run()], [agent({ currentTool: null })]),
      ),
    ).toEqual([]);
  });
});

describe("belt seeding", () => {
  it("seeds active runs newest-first and respects the cap", () => {
    const runs = [
      run({ runId: "a", status: "succeeded" }),
      run({ runId: "b", status: "running" }),
      run({ runId: "c", status: "paused" }),
    ];
    const crates = seedBeltCrates(runs, 2);
    expect(crates.map((crate) => crate.runId)).toEqual(["b", "c"]);
    expect(crates[1]?.tone).toBe("high");
  });

  it("falls back to all runs when nothing is active", () => {
    const crates = seedBeltCrates([run({ runId: "a", status: "succeeded" })]);
    expect(crates).toHaveLength(1);
  });

  it("replaces a run in place and caps the belt", () => {
    let crates = appendCrate([], {
      runId: "a",
      label: "a",
      tone: "low",
    });
    crates = appendCrate(crates, { runId: "b", label: "b", tone: "low" });
    crates = appendCrate(crates, { runId: "a", label: "a2", tone: "high" });
    expect(crates.map((crate) => crate.label)).toEqual(["b", "a2"]);

    for (let index = 0; index < MAX_BELT_CRATES + 4; index += 1) {
      crates = appendCrate(crates, {
        runId: `r${index}`,
        label: `r${index}`,
        tone: "low",
      });
    }
    expect(crates).toHaveLength(MAX_BELT_CRATES);
  });
});
