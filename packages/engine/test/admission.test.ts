import { describe, expect, it } from "vitest";
import { decideAdmission, loadAdmissionPolicy } from "../src/admission";

const base = { queueDepth: 0, maxQueueDepth: 10 };

describe("admission control", () => {
  it("evaluates budget and kill switch before the queue", () => {
    expect(
      decideAdmission({
        priority: "P0",
        queueDepth: 0,
        maxQueueDepth: 10,
        blockedBy: { kind: "kill-switch", detail: "global active" },
      }),
    ).toMatchObject({ action: "reject" });
    expect(
      decideAdmission({
        priority: "P3",
        queueDepth: 0,
        maxQueueDepth: 10,
        blockedBy: { kind: "budget", detail: "day cap reached" },
      }),
    ).toMatchObject({
      action: "reject",
      reason: expect.stringContaining("budget"),
    });
  });

  it("merges duplicate events instead of queueing twice", () => {
    expect(
      decideAdmission({ priority: "P2", duplicate: true, ...base }),
    ).toMatchObject({ action: "merge" });
  });

  it("admits P0 outright and queues normal work", () => {
    expect(decideAdmission({ priority: "P0", ...base }).action).toBe("admit");
    expect(decideAdmission({ priority: "P1", ...base }).action).toBe("queue");
    expect(decideAdmission({ priority: "P2", ...base }).action).toBe("queue");
    expect(decideAdmission({ priority: "P3", ...base }).action).toBe("queue");
  });

  it("drops low priority when the queue is full, keeps P1 waiting", () => {
    const full = { queueDepth: 10, maxQueueDepth: 10 };
    expect(decideAdmission({ priority: "P3", ...full }).action).toBe("drop");
    expect(decideAdmission({ priority: "P2", ...full }).action).toBe("queue");
    expect(decideAdmission({ priority: "P1", ...full }).action).toBe("queue");
    expect(decideAdmission({ priority: "P0", ...full }).action).toBe("admit");
  });

  it("loads the queue depth cap from env", () => {
    expect(loadAdmissionPolicy({}).maxQueueDepth).toBeGreaterThan(0);
    expect(
      loadAdmissionPolicy({ KIT_ADMISSION_MAX_QUEUE_DEPTH: "5" }),
    ).toMatchObject({ maxQueueDepth: 5 });
    expect(
      loadAdmissionPolicy({ KIT_ADMISSION_MAX_QUEUE_DEPTH: "nope" }),
    ).toMatchObject({ maxQueueDepth: 100 });
  });
});
