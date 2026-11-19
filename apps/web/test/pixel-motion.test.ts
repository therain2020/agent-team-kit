import type { ActivityEvent } from "@kit/activity";
import { describe, expect, it } from "vitest";
import {
  MAX_BELT_CRATES,
  PRESENCE_MIN_INTERVAL_MS,
  type PixelCue,
  applyPresence,
  cueFromActivity,
  pixelStateFromStatus,
  pushCrate,
  resolveMotionEnabled,
  statusFromPixelState,
} from "../lib/pixel-events";
import {
  advanceClock,
  createClockPhase,
  quantizeGameMinutes,
} from "../lib/ticker-clock";

let nextId = 1;

function event(partial: Partial<ActivityEvent>): ActivityEvent {
  return {
    eventId: nextId++,
    workspaceId: "default",
    runId: "run_1",
    stageId: "stage_a",
    agentId: "builder",
    kind: "stage.started",
    status: null,
    tool: null,
    summary: null,
    payload: null,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

function types(cues: PixelCue[]): string[] {
  return cues.map((cue) => cue.type);
}

describe("quantized game clock", () => {
  it("defaults to two game minutes per tick", () => {
    expect(quantizeGameMinutes(4, 2)).toBe(8);
    expect(quantizeGameMinutes(-3, 2)).toBe(0);
  });

  it("advances whole ticks and carries the remainder (no drift)", () => {
    const start = createClockPhase(1_000);
    const one = advanceClock(start, 1_000 + 1_199, 1_200, 1);
    expect(one.tick).toBe(0);
    const two = advanceClock(start, 1_000 + 1_200, 1_200, 1);
    expect(two.tick).toBe(1);
    expect(two.baseMs).toBe(2_200);
    const three = advanceClock(two, 1_000 + 2_000, 1_200, 1);
    expect(three.tick).toBe(1);
    const four = advanceClock(three, 1_000 + 3_600, 1_200, 1);
    expect(four.tick).toBe(3);
    expect(four.baseMs).toBe(4_600);
  });

  it("irregular frame spacing matches regular spacing", () => {
    let phase = createClockPhase(0);
    for (const now of [100, 260, 300, 890, 1_500, 2_700, 2_990, 3_600]) {
      phase = advanceClock(phase, now, 600, 1);
    }
    expect(phase.tick).toBe(6);
  });

  it("scales with speed and ignores bad input", () => {
    const start = createClockPhase(0);
    expect(advanceClock(start, 1_200, 1_200, 2).tick).toBe(2);
    expect(advanceClock(start, 600, 1_200, 0.5).tick).toBe(0);
    expect(advanceClock(start, 2_400, 1_200, 0.5).tick).toBe(1);
    expect(advanceClock(start, 10_000, 0, 1).tick).toBe(0);
    expect(advanceClock(start, Number.NaN, 1_200, 1).tick).toBe(0);
  });
});

describe("activity → motion cues", () => {
  it("tool.call drives a working agent and a bubble", () => {
    const cues = cueFromActivity(
      event({ kind: "tool.call", tool: "shell", status: "running" }),
    );
    expect(types(cues)).toEqual(["agent", "tool"]);
    expect(cues[0]).toMatchObject({ state: "working", agentId: "builder" });
    expect(cues[1]).toMatchObject({ tool: "shell" });
  });

  it("artifact.published sends a crate down the belt", () => {
    const cues = cueFromActivity(
      event({
        kind: "artifact.published",
        status: "completed",
        summary: "art_0123456789abcdef",
      }),
    );
    const crate = cues.find((cue) => cue.type === "crate");
    expect(crate).toMatchObject({
      runId: "run_1",
      label: "6789abcdef",
      bad: false,
    });
  });

  it("gate failure stamps once and reverses the belt", () => {
    const cues = cueFromActivity(
      event({ kind: "gate.evaluated", status: "failed" }),
    );
    expect(types(cues)).toContain("stamp");
    expect(types(cues)).toContain("reverse");
    expect(cues.find((cue) => cue.type === "stamp")).toMatchObject({
      outcome: "failed",
    });
  });

  it("gate pass stamps without reversing", () => {
    const cues = cueFromActivity(
      event({ kind: "gate.evaluated", status: "passed" }),
    );
    expect(cues.find((cue) => cue.type === "stamp")).toMatchObject({
      outcome: "passed",
    });
    expect(types(cues)).not.toContain("reverse");
  });

  it("approval decisions stamp and roll back on rejection", () => {
    const approved = cueFromActivity(
      event({
        kind: "approval.decided",
        status: "approve",
        agentId: "operator",
      }),
    );
    expect(approved.find((cue) => cue.type === "stamp")).toMatchObject({
      outcome: "passed",
    });
    expect(types(approved)).not.toContain("agent");
    expect(types(approved)).not.toContain("reverse");

    const rejected = cueFromActivity(
      event({ kind: "approval.decided", status: "abort", agentId: "operator" }),
    );
    expect(rejected.find((cue) => cue.type === "stamp")).toMatchObject({
      outcome: "failed",
    });
    expect(types(rejected)).toContain("reverse");
  });

  it("rollback kinds reverse the belt", () => {
    expect(
      types(cueFromActivity(event({ kind: "iteration.rollback" }))),
    ).toContain("reverse");
    expect(
      types(cueFromActivity(event({ kind: "canary.reverted", agentId: null }))),
    ).toEqual(["reverse"]);
  });

  it("approval.requested blocks and run.finished idles", () => {
    const blocked = cueFromActivity(
      event({ kind: "approval.requested", status: "pending" }),
    );
    expect(blocked[0]).toMatchObject({ type: "agent", state: "blocked" });
    const idle = cueFromActivity(event({ kind: "run.finished" }));
    expect(idle[0]).toMatchObject({ type: "agent", state: "idle" });
  });

  it("ignores events that carry no motion meaning", () => {
    expect(
      cueFromActivity(
        event({
          kind: "health.ping",
          status: null,
          agentId: null,
          runId: null,
        }),
      ),
    ).toEqual([]);
  });
});

describe("cue buffers", () => {
  const crate = (runId: string, seq: number): PixelCue => ({
    type: "crate",
    runId,
    label: runId,
    bad: false,
    seq,
  });

  it("replaces a run's crate in place and caps the belt", () => {
    let belt: PixelCue[] = [];
    belt = pushCrate(belt, crate("run_a", 1));
    belt = pushCrate(belt, crate("run_b", 2));
    belt = pushCrate(belt, crate("run_a", 3));
    expect(belt).toHaveLength(2);
    expect(belt[1]).toMatchObject({ runId: "run_a", seq: 3 });

    for (let index = 0; index < MAX_BELT_CRATES + 5; index += 1) {
      belt = pushCrate(belt, crate(`run_${index}`, index));
    }
    expect(belt).toHaveLength(MAX_BELT_CRATES);
    expect(belt.at(-1)).toMatchObject({
      runId: `run_${MAX_BELT_CRATES + 4}`,
    });
  });

  it("debounces presence per agent but not across agents", () => {
    const start = applyPresence({}, "builder", "working", 1_000);
    const tooSoon = applyPresence(start, "builder", "blocked", 1_100);
    expect(tooSoon.builder?.state).toBe("working");
    const later = applyPresence(
      tooSoon,
      "builder",
      "blocked",
      1_000 + PRESENCE_MIN_INTERVAL_MS,
    );
    expect(later.builder?.state).toBe("blocked");
    const other = applyPresence(later, "seller", "working", 1_050);
    expect(other.seller?.state).toBe("working");
  });
});

describe("motion preferences", () => {
  it("turns motion off for the toggle or the OS setting", () => {
    expect(resolveMotionEnabled(true, false)).toBe(true);
    expect(resolveMotionEnabled(false, false)).toBe(false);
    expect(resolveMotionEnabled(true, true)).toBe(false);
  });

  it("maps roster statuses onto the four sprite states", () => {
    expect(pixelStateFromStatus("working")).toBe("working");
    expect(pixelStateFromStatus("waiting")).toBe("waiting");
    expect(pixelStateFromStatus("blocked")).toBe("blocked");
    expect(pixelStateFromStatus("error")).toBe("blocked");
    expect(pixelStateFromStatus("idle")).toBe("idle");
    expect(statusFromPixelState("waiting")).toBe("idle");
  });

  it("keeps data cues intact when motion is off", () => {
    // Turning motion off freezes stepping/shake/reverse, but state changes
    // still arrive: the sprite state is carried by the cue, not the clock.
    expect(resolveMotionEnabled(false, false)).toBe(false);
    const cues = cueFromActivity(
      event({ kind: "approval.requested", status: "pending" }),
    );
    expect(cues[0]).toMatchObject({ type: "agent", state: "blocked" });
    expect(quantizeGameMinutes(0, 2)).toBe(0);
  });
});
