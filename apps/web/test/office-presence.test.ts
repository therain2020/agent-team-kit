import type { ActivityEvent } from "@kit/activity";
import { describe, expect, it } from "vitest";
import {
  createPresenceSnapshot,
  reducePresence,
  reducePresenceBatch,
  withRunScope,
} from "../lib/office-presence";

let nextId = 1;

function event(partial: Partial<ActivityEvent>): ActivityEvent {
  return {
    eventId: nextId++,
    workspaceId: "default",
    runId: "run_1",
    stageId: "s1",
    agentId: "builder",
    kind: "stage.started",
    status: null,
    tool: null,
    summary: null,
    payload: null,
    createdAt: new Date(1_700_000_000_000 + nextId).toISOString(),
    ...partial,
  };
}

function snapshot() {
  return createPresenceSnapshot(
    "manager",
    ["builder", "seller"],
    ["run_1"],
    "2026-11-20T00:00:00.000Z",
  );
}

describe("office presence reducer", () => {
  it("walks run/stage/tool events into working and manager supervision", () => {
    const started = reducePresence(
      snapshot(),
      event({ kind: "run.started", status: "running" }),
    );
    expect(started.agents.builder).toMatchObject({
      status: "working",
      runId: "run_1",
    });
    expect(started.agents.manager).toMatchObject({
      status: "working",
      runId: "run_1",
    });

    const tool = reducePresence(
      started,
      event({ kind: "tool.call", tool: "shell" }),
    );
    expect(tool.agents.builder?.status).toBe("working");
    expect(tool.agents.manager?.status).toBe("working");
  });

  it("blocks on approval and resumes on approval.decided", () => {
    const blocked = reducePresence(
      snapshot(),
      event({ kind: "approval.requested", status: "pending" }),
    );
    expect(blocked.agents.builder?.status).toBe("blocked");
    expect(blocked.agents.manager?.status).toBe("blocked");
    expect(blocked.runs.run_1).toBe("blocked");

    const resumed = reducePresence(
      blocked,
      event({ kind: "approval.decided", status: "approve" }),
    );
    expect(resumed.agents.builder?.status).toBe("working");
    expect(resumed.agents.manager?.status).toBe("working");

    const rejected = reducePresence(
      blocked,
      event({ kind: "approval.decided", status: "reject", agentId: "ops" }),
    );
    expect(rejected.runs.run_1).toBeUndefined();
    expect(rejected.agents.manager?.status).toBe("idle");
  });

  it("finishes to idle and fails to error with a terminal run", () => {
    const finished = reducePresence(
      snapshot(),
      event({ kind: "run.finished", status: "succeeded" }),
    );
    expect(finished.agents.builder).toMatchObject({
      status: "idle",
      runId: null,
    });
    expect(finished.agents.manager?.status).toBe("idle");
    expect(finished.runs.run_1).toBeUndefined();

    const failed = reducePresence(
      snapshot(),
      event({ kind: "run.failed", status: "failed" }),
    );
    expect(failed.agents.builder?.status).toBe("error");
    expect(failed.agents.manager?.status).toBe("idle");
  });

  it("only updates the manager for workflow-level events", () => {
    const next = reducePresence(
      snapshot(),
      event({ kind: "stage.started", agentId: null, status: "running" }),
    );
    expect(next.agents.builder?.status).toBe("idle");
    expect(next.agents.manager?.status).toBe("working");
    expect(next.runs.run_1).toBe("working");
  });

  it("drops replayed events at or behind the cursor", () => {
    const base = snapshot();
    const first = reducePresence(
      base,
      event({ eventId: 10, kind: "run.started" }),
    );
    const replay = reducePresence(
      first,
      event({ eventId: 10, kind: "run.failed" }),
    );
    expect(replay).toBe(first);
    const older = reducePresence(
      replay,
      event({ eventId: 9, kind: "run.failed" }),
    );
    expect(older).toBe(replay);
  });

  it("ignores other Packs' runs without advancing the cursor", () => {
    const base = snapshot();
    const next = reducePresence(
      base,
      event({ eventId: 42, runId: "run_other", kind: "run.started" }),
    );
    expect(next).toBe(base);
    expect(next.cursor).toBe(0);
  });

  it("updates scope and applies the remaining batch", () => {
    const scoped = withRunScope(snapshot(), ["run_1", "run_2"]);
    const next = reducePresenceBatch(scoped, [
      event({ kind: "run.started", runId: "run_2", agentId: "seller" }),
      event({
        kind: "approval.requested",
        runId: "run_2",
        agentId: "seller",
        status: "pending",
      }),
    ]);
    expect(next.agents.seller).toMatchObject({
      status: "blocked",
      runId: "run_2",
    });
    expect(next.runs).toEqual({ run_2: "blocked" });
    expect(next.agents.manager?.status).toBe("blocked");
  });

  it("does not invent agents from events", () => {
    const next = reducePresence(
      snapshot(),
      event({ kind: "tool.call", agentId: "stranger" }),
    );
    expect(next.agents.stranger).toBeUndefined();
    // The scoped run still registers, so the manager shows supervision.
    expect(next.agents.manager?.status).toBe("working");
  });
});
