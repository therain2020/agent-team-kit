import {
  BoundedEventSpool,
  MemorySpoolStore,
  SpoolBackpressureError,
} from "@kit/queue";
import type {
  DegradationAuditRecord,
  DegradationStateRecord,
} from "@kit/store";
import { describe, expect, it, vi } from "vitest";
import { EventSpoolSupervisor } from "../src/spool-supervisor";

const encode = (value: string) => new TextEncoder().encode(value);

class FlakyPublisher {
  down = false;
  readonly published: string[] = [];

  async publish(
    _subject: string,
    _data: Uint8Array,
    messageId?: string,
  ): Promise<void> {
    if (this.down) {
      throw new Error("nats unavailable");
    }
    this.published.push(messageId ?? "");
  }
}

function fakeDegradation() {
  return {
    states: [] as DegradationStateRecord[],
    audits: [] as DegradationAuditRecord[],
    exits: [] as Array<{ workspaceId: string; reason: string }>,
    async upsert(record: DegradationStateRecord) {
      this.states.push(record);
    },
    async markExited(
      _scope: DegradationStateRecord["scope"],
      workspaceId: string,
      _exitedAt: string,
      reason: string,
    ) {
      this.exits.push({ workspaceId, reason });
      return true;
    },
    async appendAudit(record: DegradationAuditRecord) {
      this.audits.push(record);
    },
  };
}

function setup(options: { maxPending?: number } = {}) {
  const store = new MemorySpoolStore();
  const spool = new BoundedEventSpool({
    store,
    maxPending: options.maxPending,
    now: () => "2026-11-15T00:00:00.000Z",
  });
  const publisher = new FlakyPublisher();
  const degradation = fakeDegradation();
  const warnings: Error[] = [];
  const supervisor = new EventSpoolSupervisor({
    spool,
    publisher,
    degradation,
    workspaceId: "ws-1",
    now: () => "2026-11-15T00:00:00.000Z",
    onWarning: (error) => warnings.push(error),
  });
  return { store, spool, publisher, degradation, supervisor, warnings };
}

describe("event spool supervisor", () => {
  it("buffers on bus failure, enters degraded mode once, and exits after replay", async () => {
    const { publisher, degradation, supervisor } = setup();

    const healthy = await supervisor.publish("kit.events.>", encode("ok"), {
      eventId: "evt-0",
    });
    expect(healthy.status).toBe("published");
    expect(degradation.audits).toHaveLength(0);

    publisher.down = true;
    expect(
      await supervisor.publish("kit.events.>", encode("a"), {
        eventId: "evt-1",
        priority: "P0",
      }),
    ).toMatchObject({ status: "buffered" });
    expect(
      await supervisor.publish("kit.events.>", encode("b"), {
        eventId: "evt-2",
        priority: "P3",
      }),
    ).toMatchObject({ status: "buffered" });

    expect(supervisor.buffering).toBe(true);
    expect(degradation.states).toHaveLength(1);
    expect(degradation.states[0]).toMatchObject({
      scope: "workspace",
      workspaceId: "ws-1",
      kind: "degraded",
      status: "active",
    });
    expect(degradation.audits).toHaveLength(1);
    expect(degradation.audits[0]).toMatchObject({
      action: "enter",
      workspaceId: "ws-1",
    });
    expect(degradation.audits[0]?.detail).toMatchObject({
      dependencyId: "event_bus",
      aggregate: { total: 0 },
    });

    publisher.down = false;
    expect(
      (
        await supervisor.publish("kit.events.>", encode("c"), {
          eventId: "evt-3",
        })
      ).status,
    ).toBe("published");
    expect(supervisor.buffering).toBe(true);

    const applied: string[] = [];
    const report = await supervisor.replay(
      {
        apply: async (entry) => {
          applied.push(entry.eventId);
        },
      },
      { runMode: "LIVE" },
    );

    expect(applied).toEqual(["evt-1", "evt-2"]);
    expect(report).toMatchObject({ delivered: 2, remaining: 0, failed: [] });
    expect(supervisor.buffering).toBe(false);
    expect(degradation.exits).toEqual([
      { workspaceId: "ws-1", reason: "event bus recovered; spool replayed" },
    ]);
    expect(degradation.audits.map((audit) => audit.action)).toEqual([
      "enter",
      "exit",
    ]);

    const again = await supervisor.replay(
      { apply: async () => undefined },
      { runMode: "LIVE" },
    );
    expect(again.delivered).toBe(0);
    expect(degradation.audits).toHaveLength(2);
  });

  it("does not replay idempotently delivered events twice", async () => {
    const { publisher, spool, supervisor } = setup();
    publisher.down = true;
    await supervisor.publish("kit.events.>", encode("a"), {
      eventId: "evt-1",
      priority: "P1",
    });

    const apply = vi.fn();
    await supervisor.replay({ apply }, { runMode: "LIVE" });
    await supervisor.replay({ apply }, { runMode: "LIVE" });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(await spool.snapshot()).toHaveLength(0);
  });

  it("keeps the backlog and degraded state during non-LIVE drills", async () => {
    const { publisher, spool, supervisor, degradation } = setup();
    publisher.down = true;
    await supervisor.publish("kit.events.>", encode("a"), {
      eventId: "evt-1",
      priority: "P0",
    });

    const apply = vi.fn();
    const simulate = vi.fn();
    const report = await supervisor.replay(
      { apply, simulate },
      { runMode: "DRY_RUN" },
    );

    expect(apply).not.toHaveBeenCalled();
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ simulated: 1, delivered: 0, remaining: 1 });
    expect(supervisor.buffering).toBe(true);
    expect(degradation.audits).toHaveLength(1);
    expect(await spool.snapshot()).toHaveLength(1);
  });

  it("propagates backpressure instead of overflowing the spool", async () => {
    const { publisher, supervisor, degradation } = setup({ maxPending: 1 });
    publisher.down = true;

    await supervisor.publish("kit.events.>", encode("a"), {
      eventId: "evt-1",
      priority: "P1",
    });
    await expect(
      supervisor.publish("kit.events.>", encode("b"), {
        eventId: "evt-2",
        priority: "P2",
      }),
    ).rejects.toBeInstanceOf(SpoolBackpressureError);

    expect((await supervisor.aggregate()).total).toBe(1);
    expect(degradation.audits).toHaveLength(1);
  });

  it("buffers without audit rows when no degradation store is wired", async () => {
    const store = new MemorySpoolStore();
    const spool = new BoundedEventSpool({ store });
    const publisher = new FlakyPublisher();
    publisher.down = true;
    const supervisor = new EventSpoolSupervisor({ spool, publisher });

    const outcome = await supervisor.publish("kit.events.>", encode("a"), {
      eventId: "evt-1",
    });
    expect(outcome.status).toBe("buffered");
    expect(supervisor.buffering).toBe(true);
  });
});
