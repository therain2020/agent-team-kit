import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendActivity, listActivity } from "@kit/activity";
import type { CoderStreamEvent } from "@kit/coder";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  type IterationActivityContext,
  coderEventToActivity,
} from "../src/iteration-activities";

const context: IterationActivityContext = {
  workspaceId: "default",
  iterationId: "it_activity_1",
  taskId: "t1",
  agentId: "patcher",
  coder: "dsh",
};

function streamEvent(
  event: Partial<CoderStreamEvent> & Pick<CoderStreamEvent, "kind">,
): CoderStreamEvent {
  return { at: "2026-11-15T00:00:00.000Z", ...event };
}

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-iteration-activity-"));
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

describe("coderEventToActivity", () => {
  it("maps turn boundaries onto iteration.coder.turn", () => {
    const started = coderEventToActivity(
      streamEvent({ kind: "turn_start", turn: 2 }),
      context,
    );
    expect(started).toMatchObject({
      runId: "it_activity_1",
      stageId: "it_activity_1:t1:coder",
      agentId: "patcher",
      kind: "iteration.coder.turn",
      status: "running",
    });
    expect(started?.payload).toMatchObject({ turn: 2, coder: "dsh" });

    const finished = coderEventToActivity(
      streamEvent({
        kind: "turn_end",
        turn: 2,
        status: "completed",
        tokens: 120,
        summary: "done",
      }),
      context,
    );
    expect(finished).toMatchObject({
      kind: "iteration.coder.turn",
      status: "completed",
      summary: "done",
    });
    expect(finished?.payload).toMatchObject({ turn: 2, tokens: 120 });
  });

  it("maps tool calls and pairs results by callId", () => {
    const toolNames = new Map<string, string>();
    const call = coderEventToActivity(
      streamEvent({
        kind: "tool_call",
        callId: "call-1",
        tool: "read",
        summary: "read: README.md",
        payload: { input: { path: "README.md" } },
      }),
      context,
      toolNames,
    );
    expect(call).toMatchObject({
      kind: "iteration.coder.tool",
      status: "running",
      tool: "read",
      summary: "read: README.md",
    });

    const result = coderEventToActivity(
      streamEvent({
        kind: "tool_result",
        callId: "call-1",
        status: "completed",
        summary: "# kit",
        payload: { result: { ok: true } },
      }),
      context,
      toolNames,
    );
    expect(result).toMatchObject({
      kind: "iteration.coder.tool_result",
      tool: "read",
      status: "completed",
      summary: "# kit",
    });
  });

  it("keeps fine-grained text out of the activity stream", () => {
    for (const kind of [
      "thinking",
      "text",
      "step_start",
      "step_end",
      "final",
    ] as const) {
      expect(coderEventToActivity(streamEvent({ kind }), context)).toBeNull();
    }
  });

  it("maps coder errors to failed turns", () => {
    const mapped = coderEventToActivity(
      streamEvent({ kind: "error", turn: 1, summary: "boom" }),
      context,
    );
    expect(mapped).toMatchObject({
      kind: "iteration.coder.turn",
      status: "failed",
      summary: "boom",
    });
  });
});

describe("iteration activity persistence", () => {
  it("replays iteration events by runId and redacts secrets", async () => {
    const store = await sqliteStore();
    const mapped = coderEventToActivity(
      streamEvent({
        kind: "tool_call",
        callId: "call-2",
        tool: "http",
        payload: { input: { apiKey: "sk-live-secret", url: "https://x.test" } },
      }),
      context,
    );
    expect(mapped).not.toBeNull();
    if (mapped) {
      await appendActivity(store, mapped);
    }

    const events = await listActivity(store, { runId: context.iterationId });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("iteration.coder.tool");
    expect(events[0]?.agentId).toBe("patcher");
    const payload = events[0]?.payload as {
      input?: Record<string, unknown>;
    };
    expect(payload.input?.apiKey).toBe("[redacted]");
    expect(payload.input?.url).toBe("https://x.test");
  });
});
