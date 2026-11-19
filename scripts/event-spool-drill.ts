import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BoundedEventSpool,
  type SpoolPriority,
  type SpoolRecord,
} from "@kit/queue";
import { initStore, loadStoreConfig } from "@kit/store";
import { EventSpoolSupervisor } from "../apps/runtime/src/spool-supervisor";

/**
 * Event bus spool drill (61 §3.2, D-38).
 *
 * Simulates an event bus outage against the local SQLite store:
 * 1. zero-loss: buffer every event, replay LIVE in order, replay again and
 *    prove event_id dedupe delivers nothing twice;
 * 2. bounded: a small cap sheds P3 first and retains P0/P1 via backpressure;
 * 3. non-LIVE: a DRY_RUN replay only touches the sandbox hook and leaves the
 *    backlog untouched.
 *
 * Run: `bun run drill:event-spool`
 */

const root = await mkdtemp(path.join(os.tmpdir(), "kit-spool-drill-"));
const store = await initStore(
  loadStoreConfig({
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: root,
    KIT_BLOB_ROOT: path.join(root, "blobs"),
  }),
);

class DrillPublisher {
  down = true;
  async publish(
    _subject: string,
    _data: Uint8Array,
    _messageId?: string,
  ): Promise<void> {
    if (this.down) {
      throw new Error("drill: event bus unavailable");
    }
  }
}

const encode = (value: string) => new TextEncoder().encode(value);

async function zeroLoss(): Promise<Record<string, unknown>> {
  const publisher = new DrillPublisher();
  const spool = new BoundedEventSpool({ store: store.spool, maxPending: 16 });
  const supervisor = new EventSpoolSupervisor({
    spool,
    publisher,
    degradation: store.degradation,
    workspaceId: "drill",
    actor: "drill",
    onWarning: () => undefined,
  });

  const priorities: SpoolPriority[] = ["P0", "P1", "P2", "P3", "P3"];
  for (const [index, priority] of priorities.entries()) {
    const outcome = await supervisor.publish(
      "kit.events.>",
      encode(`event-${index}`),
      { eventId: `drill-zero-${index}`, priority },
    );
    if (outcome.status !== "buffered") {
      throw new Error(`expected buffered, got ${outcome.status}`);
    }
  }

  const applied: string[] = [];
  const target = {
    apply: async (record: SpoolRecord) => {
      applied.push(record.eventId);
    },
  };
  publisher.down = false;
  const first = await supervisor.replay(target, { runMode: "LIVE" });
  const second = await supervisor.replay(target, { runMode: "LIVE" });

  const audits = await store.degradation.listAudit(10);
  if (
    first.delivered !== priorities.length ||
    applied.length !== priorities.length
  ) {
    throw new Error("zero-loss: not every buffered event was delivered");
  }
  if (second.delivered !== 0) {
    throw new Error("zero-loss: replay was not idempotent");
  }
  if (!audits.some((audit) => audit.action === "exit")) {
    throw new Error("zero-loss: replay did not exit degraded mode");
  }

  return {
    buffered: priorities.length,
    delivered: first.delivered,
    replayedAgain: second.delivered,
    auditActions: audits.map((audit) => audit.action),
  };
}

async function bounded(): Promise<Record<string, unknown>> {
  const spool = new BoundedEventSpool({ store: store.spool, maxPending: 2 });
  const first = await spool.enqueue({
    eventId: "drill-bound-p3-a",
    subject: "kit.events.>",
    data: encode("a"),
    priority: "P3",
    workspaceId: "drill",
  });
  await spool.enqueue({
    eventId: "drill-bound-p1",
    subject: "kit.events.>",
    data: encode("b"),
    priority: "P1",
    workspaceId: "drill",
  });
  const shed = await spool.enqueue({
    eventId: "drill-bound-p3-b",
    subject: "kit.events.>",
    data: encode("c"),
    priority: "P3",
    workspaceId: "drill",
  });
  const aggregate = await spool.aggregate();

  if (first.status !== "buffered" || shed.status !== "dropped") {
    throw new Error("bounded: P3 shedding policy did not apply");
  }
  if (aggregate.byPriority.P1 !== 1 || aggregate.dropped.P3 !== 1) {
    throw new Error("bounded: P0/P1 were not retained");
  }

  return {
    statuses: [first.status, shed.status],
    byPriority: aggregate.byPriority,
    dropped: aggregate.dropped,
  };
}

async function nonLive(): Promise<Record<string, unknown>> {
  const spool = new BoundedEventSpool({ store: store.spool, maxPending: 4 });
  await spool.enqueue({
    eventId: "drill-nonlive-1",
    subject: "kit.events.>",
    data: encode("a"),
    priority: "P0",
    workspaceId: "drill",
  });

  const applied: string[] = [];
  const simulated: string[] = [];
  const report = await spool.replay(
    {
      apply: async (record) => {
        applied.push(record.eventId);
      },
      simulate: async (record) => {
        simulated.push(record.eventId);
      },
    },
    { runMode: "DRY_RUN" },
  );

  if (applied.length !== 0 || report.remaining !== 1) {
    throw new Error("non-LIVE: replay produced real side effects");
  }

  return {
    simulated: simulated.length,
    delivered: report.delivered,
    remaining: report.remaining,
    backlogUntouched: (await spool.snapshot()).length,
  };
}

try {
  const report = {
    zeroLoss: await zeroLoss(),
    bounded: await bounded(),
    nonLive: await nonLive(),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
