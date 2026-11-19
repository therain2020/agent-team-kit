import { describe, expect, it, vi } from "vitest";
import {
  BoundedEventSpool,
  MemorySpoolStore,
  SpoolBackpressureError,
  type SpoolRecord,
  SpoolReplayError,
} from "../src/index";

const encode = (value: string) => new TextEncoder().encode(value);

const at = (second: number) =>
  new Date(Date.UTC(2026, 10, 15, 0, 0, second)).toISOString();

function makeSpool(
  options: Partial<ConstructorParameters<typeof BoundedEventSpool>[0]> = {},
) {
  const store = options.store ?? new MemorySpoolStore();
  const spool = new BoundedEventSpool({
    store,
    now: () => at(0),
    ...options,
  });
  return { store, spool };
}

function entry(
  eventId: string,
  priority: SpoolRecord["priority"] = "P2",
): Parameters<BoundedEventSpool["enqueue"]>[0] {
  return {
    eventId,
    subject: "kit.events.>",
    data: encode(eventId),
    priority,
    workspaceId: "ws-1",
  };
}

describe("bounded event spool", () => {
  it("buffers in order and replays each event exactly once", async () => {
    const { store, spool } = makeSpool();
    await spool.enqueue(entry("e1", "P0"));
    await spool.enqueue(entry("e2", "P1"));

    const applied: string[] = [];
    const report = await spool.replay(
      {
        apply: async (record) => {
          applied.push(record.eventId);
        },
      },
      { runMode: "LIVE" },
    );

    expect(applied).toEqual(["e1", "e2"]);
    expect(report).toMatchObject({
      live: true,
      attempted: 2,
      delivered: 2,
      remaining: 0,
      failed: [],
    });
    expect(await store.isDelivered("e1")).toBe(true);
    expect(await spool.snapshot()).toHaveLength(0);

    const again = await spool.replay(
      { apply: async () => undefined },
      { runMode: "LIVE" },
    );
    expect(again.delivered).toBe(0);
    expect(again.remaining).toBe(0);
  });

  it("dedupes by event_id on enqueue and defensive replay", async () => {
    const { store, spool } = makeSpool();
    expect((await spool.enqueue(entry("e1"))).status).toBe("buffered");
    expect((await spool.enqueue(entry("e1"))).status).toBe("duplicate");

    // Simulate a crash after apply but before the pending row was removed:
    // delivery history already records the id while the row is still pending.
    await store.markDelivered("e1", at(1));
    const apply = vi.fn();
    const report = await spool.replay({ apply }, { runMode: "LIVE" });

    expect(apply).not.toHaveBeenCalled();
    expect(report.duplicates).toBe(1);
    expect(report.delivered).toBe(0);
    expect(report.remaining).toBe(0);
  });

  it("sheds P3 first when the backlog is full", async () => {
    const { spool } = makeSpool({ maxPending: 2 });
    await spool.enqueue(entry("p3-a", "P3"));
    await spool.enqueue(entry("p3-b", "P3"));

    const result = await spool.enqueue(entry("p3-c", "P3"));
    expect(result).toMatchObject({
      status: "dropped",
      priority: "P3",
      reason: "priority_shed",
    });

    const aggregate = await spool.aggregate();
    expect(aggregate.total).toBe(2);
    expect(aggregate.byPriority.P3).toBe(2);
    expect(aggregate.dropped.P3).toBe(1);
    expect((await spool.snapshot()).map((record) => record.eventId)).toEqual([
      "p3-a",
      "p3-b",
    ]);
  });

  it("evicts the oldest P3 before accepting a P0/P1 event", async () => {
    const { spool } = makeSpool({ maxPending: 2 });
    await spool.enqueue(entry("p3-a", "P3"));
    await spool.enqueue(entry("p1-b", "P1"));

    const result = await spool.enqueue(entry("p0-c", "P0"));
    expect(result).toMatchObject({
      status: "buffered",
      evicted: ["p3-a"],
    });
    expect((await spool.snapshot()).map((record) => record.eventId)).toEqual([
      "p1-b",
      "p0-c",
    ]);
  });

  it("applies backpressure instead of dropping P0/P1", async () => {
    const { spool } = makeSpool({ maxPending: 1 });
    await spool.enqueue(entry("p1-a", "P1"));

    const failure = spool.enqueue(entry("p2-b", "P2"));
    await expect(failure).rejects.toBeInstanceOf(SpoolBackpressureError);

    const aggregate = await spool.aggregate();
    expect(aggregate.total).toBe(1);
    expect(aggregate.byPriority.P1).toBe(1);
    expect((await spool.snapshot())[0]?.eventId).toBe("p1-a");
  });

  it("keeps P0/P1 when a full spool only holds retained events", async () => {
    const { spool } = makeSpool({ maxPending: 2 });
    await spool.enqueue(entry("p0-a", "P0"));
    await spool.enqueue(entry("p1-b", "P1"));

    await expect(spool.enqueue(entry("p1-c", "P1"))).rejects.toBeInstanceOf(
      SpoolBackpressureError,
    );
    const aggregate = await spool.aggregate();
    expect(aggregate.byPriority).toMatchObject({ P0: 1, P1: 1, P3: 0 });
  });

  it("only simulates in non-LIVE modes and never consumes the backlog", async () => {
    const { store, spool } = makeSpool();
    await spool.enqueue(entry("e1", "P0"));
    await spool.enqueue(entry("e2", "P3"));

    const apply = vi.fn();
    const simulate = vi.fn();
    const report = await spool.replay(
      { apply, simulate },
      { runMode: "DRY_RUN" },
    );

    expect(apply).not.toHaveBeenCalled();
    expect(simulate).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({
      live: false,
      simulated: 2,
      delivered: 0,
      remaining: 2,
    });
    expect(await store.isDelivered("e1")).toBe(false);
    expect(await spool.snapshot()).toHaveLength(2);
  });

  it("refuses a non-LIVE replay without a sandbox executor", async () => {
    const { spool } = makeSpool();
    await spool.enqueue(entry("e1"));

    await expect(
      spool.replay({ apply: async () => undefined }, { runMode: "REPLAY" }),
    ).rejects.toBeInstanceOf(SpoolReplayError);
  });

  it("keeps order and the remaining backlog after a failed replay", async () => {
    const { spool } = makeSpool();
    await spool.enqueue(entry("e1", "P0"));
    await spool.enqueue(entry("e2", "P0"));
    await spool.enqueue(entry("e3", "P0"));

    const applied: string[] = [];
    const first = await spool.replay(
      {
        apply: async (record) => {
          if (record.eventId === "e2") {
            throw new Error("sink down");
          }
          applied.push(record.eventId);
        },
      },
      { runMode: "LIVE" },
    );

    expect(applied).toEqual(["e1"]);
    expect(first.failed).toEqual([{ eventId: "e2", reason: "sink down" }]);
    expect(first.remaining).toBe(2);

    const second = await spool.replay(
      {
        apply: async (record) => {
          applied.push(record.eventId);
        },
      },
      { runMode: "LIVE" },
    );
    expect(applied).toEqual(["e1", "e2", "e3"]);
    expect(second.delivered).toBe(2);
    expect(second.remaining).toBe(0);
  });
});
