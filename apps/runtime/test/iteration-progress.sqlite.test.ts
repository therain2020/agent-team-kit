import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TaskPlan } from "@kit/core";
import { initStore, loadStoreConfig } from "@kit/store";
import type { IterationInput } from "@kit/workflow";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  startIteration,
} from "../src/temporal/iteration-progress";

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

async function sqliteStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-iteration-"));
  dirs.push(dir);
  const config = loadStoreConfig({
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: dir,
    KIT_BLOB_ROOT: path.join(dir, "blobs"),
  });
  const store = await initStore(config);
  closers.push(() => store.close());
  return store;
}

describe("iteration progress on sqlite", () => {
  it("persists runs, tasks, events and the turn projection", async () => {
    const store = await sqliteStore();
    const input: IterationInput = {
      iterationId: "it_sqlite_1",
      workspaceId: "default",
      packDir: "packs/self-improve",
      goal: "verify iteration events on sqlite",
      acceptance: "events and turns persist",
      maxTasks: 1,
      maxRepair: 1,
      runMode: "DRY_RUN",
      applyMode: "none",
      stub: true,
    };
    const plan: TaskPlan = {
      goal: input.goal,
      summary: "one task",
      tasks: [
        {
          id: "t1",
          domain: "docs",
          goal: "write docs",
          acceptance: "docs exist",
          filesHint: [],
          risk: "low",
          dependsOn: [],
        },
      ],
    };

    await startIteration(store, input, plan, "art_plan");
    await appendEvent(store, {
      iterationId: input.iterationId,
      taskId: "t1",
      turn: 1,
      kind: "coder.turn_start",
      status: "running",
      summary: "turn 1",
    });
    await appendEvent(store, {
      iterationId: input.iterationId,
      taskId: "t1",
      turn: 1,
      step: 1,
      kind: "coder.step_start",
    });
    await appendEvent(store, {
      iterationId: input.iterationId,
      taskId: "t1",
      turn: 1,
      step: 1,
      kind: "coder.tool_call",
      tool: "read",
      payload: { callId: "call-1", input: { path: "README.md" } },
    });
    await appendEvent(store, {
      iterationId: input.iterationId,
      taskId: "t1",
      turn: 1,
      step: 1,
      kind: "coder.tool_result",
      tool: "read",
      payload: { callId: "call-1", status: "ok" },
    });
    await appendEvent(store, {
      iterationId: input.iterationId,
      taskId: "t1",
      turn: 1,
      step: 1,
      kind: "coder.step_end",
      tokens: 120,
    });
    await appendEvent(store, {
      iterationId: input.iterationId,
      taskId: "t1",
      turn: 1,
      kind: "coder.turn_end",
      status: "completed",
      tokens: 120,
      summary: "turn finished",
    });

    const runs = await store.sql<
      Array<{
        status: string;
        phase: string;
        last_event_id: number;
        turn_count: number;
        tool_calls: number;
        last_heartbeat_at: string | null;
      }>
    >`
      SELECT status, phase, last_event_id, turn_count, tool_calls,
             last_heartbeat_at
      FROM iteration_runs WHERE iteration_id = ${input.iterationId}
    `;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("running");
    expect(runs[0]?.phase).toBe("planned");
    expect(Number(runs[0]?.turn_count)).toBe(1);
    expect(Number(runs[0]?.tool_calls)).toBe(1);
    expect(Number(runs[0]?.last_event_id)).toBeGreaterThan(0);
    expect(runs[0]?.last_heartbeat_at).toBeTruthy();

    const tasks = await store.sql<Array<{ status: string }>>`
      SELECT status FROM iteration_tasks WHERE iteration_id = ${input.iterationId}
    `;
    expect(tasks).toHaveLength(1);

    const events = await store.sql<Array<{ kind: string; payload: string }>>`
      SELECT kind, payload FROM iteration_events
      WHERE iteration_id = ${input.iterationId} ORDER BY event_id ASC
    `;
    expect(events.map((event) => event.kind)).toEqual([
      "run.started",
      "task.planned",
      "coder.turn_start",
      "coder.step_start",
      "coder.tool_call",
      "coder.tool_result",
      "coder.step_end",
      "coder.turn_end",
    ]);
    const toolCall = events.find((event) => event.kind === "coder.tool_call");
    expect(JSON.parse(toolCall?.payload ?? "{}")).toMatchObject({
      callId: "call-1",
    });

    const turns = await store.sql<
      Array<{
        status: string;
        steps: number;
        tool_calls: number;
        tokens: number;
        summary: string | null;
      }>
    >`
      SELECT status, steps, tool_calls, tokens, summary FROM iteration_turns
      WHERE iteration_id = ${input.iterationId}
    `;
    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe("completed");
    expect(Number(turns[0]?.steps)).toBe(1);
    expect(Number(turns[0]?.tool_calls)).toBe(1);
    expect(Number(turns[0]?.tokens)).toBe(120);
    expect(turns[0]?.summary).toBe("turn finished");
  }, 60_000);
});
