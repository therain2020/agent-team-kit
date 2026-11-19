import type { PriorityClass } from "@kit/core";
import { describe, expect, it } from "vitest";
import { WorkspaceFairQueue, percentile } from "../src/fair-queue";

function item(
  id: string,
  workspaceId: string,
  priority: PriorityClass = "P2",
  enqueuedAt = 0,
) {
  return { id, workspaceId, priority, enqueuedAt, payload: { id } };
}

function drain<T>(queue: WorkspaceFairQueue<T>, count: number, now = 1_000) {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const next = queue.dequeue(now);
    if (!next) {
      break;
    }
    out.push(next.item.id);
  }
  return out;
}

describe("WorkspaceFairQueue", () => {
  it("interleaves a two-workspace burst so one cannot starve the other", () => {
    const queue = new WorkspaceFairQueue<{ id: string }>();
    for (let i = 0; i < 100; i += 1) {
      queue.enqueue(item(`a-${i}`, "alpha"));
    }
    for (let i = 0; i < 10; i += 1) {
      queue.enqueue(item(`b-${i}`, "beta"));
    }
    const order = drain(queue, 20);
    const betaPositions = order
      .map((id, index) => (id.startsWith("b-") ? index : -1))
      .filter((index) => index >= 0);
    // Equal weights: beta's 10 items are all served within the first 20 picks.
    expect(betaPositions.length).toBeGreaterThanOrEqual(8);
    expect(Math.max(...betaPositions)).toBeLessThan(20);
    expect(order.filter((id) => id.startsWith("a-"))).toHaveLength(
      20 - betaPositions.length,
    );
  });

  it("honors per-workspace weights in the long run", () => {
    const queue = new WorkspaceFairQueue<{ id: string }>({
      weights: { alpha: 3, beta: 1 },
    });
    for (let i = 0; i < 60; i += 1) {
      queue.enqueue(item(`a-${i}`, "alpha"));
    }
    for (let i = 0; i < 60; i += 1) {
      queue.enqueue(item(`b-${i}`, "beta"));
    }
    const order = drain(queue, 60);
    const alpha = order.filter((id) => id.startsWith("a-")).length;
    const beta = order.filter((id) => id.startsWith("b-")).length;
    expect(alpha).toBeGreaterThan(beta * 2);
    expect(alpha).toBeLessThan(beta * 5);
  });

  it("serves higher priority classes first within a workspace", () => {
    const queue = new WorkspaceFairQueue<{ id: string }>();
    queue.enqueue(item("p3", "alpha", "P3"));
    queue.enqueue(item("p2", "alpha", "P2"));
    queue.enqueue(item("p0", "alpha", "P0"));
    expect(drain(queue, 3)).toEqual(["p0", "p2", "p3"]);
  });

  it("lets a P0 item preempt the workspace rotation", () => {
    const queue = new WorkspaceFairQueue<{ id: string }>();
    queue.enqueue(item("a-1", "alpha"));
    queue.preemptWith(item("urgent", "alpha", "P0"));
    expect(drain(queue, 1)).toEqual(["urgent"]);
  });

  it("reports queue length, priority distribution and wait p95", () => {
    const queue = new WorkspaceFairQueue<{ id: string }>();
    queue.enqueue(item("a-1", "alpha", "P1", 0));
    queue.enqueue(item("a-2", "alpha", "P3", 500));
    queue.enqueue(item("b-1", "beta", "P2", 0));
    const snapshot = queue.snapshot(1_000);
    expect(snapshot.depth).toBe(3);
    expect(snapshot.byWorkspace).toEqual({ alpha: 2, beta: 1 });
    expect(snapshot.byPriority).toEqual({ P0: 0, P1: 1, P2: 1, P3: 1 });
    expect(snapshot.oldestWaitMs).toBe(1_000);

    queue.dequeue(1_000);
    queue.dequeue(1_000);
    const spent = queue.snapshot(1_000);
    expect(spent.waitP95Ms).toBeGreaterThan(0);
    expect(spent.servedByPriority.P1).toBe(1);
  });

  it("removes queued work by id", () => {
    const queue = new WorkspaceFairQueue<{ id: string }>();
    queue.enqueue(item("a-1", "alpha"));
    expect(queue.remove("a-1")?.id).toBe("a-1");
    expect(queue.remove("a-1")).toBeNull();
    expect(queue.size).toBe(0);
  });
});

describe("percentile", () => {
  it("is empty-safe and p95-shaped", () => {
    expect(percentile([], 0.95)).toBe(0);
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.95)).toBe(96);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 1)).toBe(100);
  });
});
